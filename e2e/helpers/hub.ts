import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket, type RawData } from "ws";
import { Client } from "pg";
import { z } from "zod";
import type { SourcePaseo, SourceRegistration } from "./source-paseo.js";
import type { BrowserDiscordEvent } from "../../src/e2e/harness/browser-providers.js";
import type { BrowserProviderScenario } from "../../src/e2e/harness/browser-providers.js";
import { createDatabase } from "../../src/db/pg.js";
import { ProjectConfigurationStore } from "../../src/configuration/store.js";
import { slugify } from "../../src/slug.js";
import { ProjectNavigation } from "./projects/navigation.js";
import { ProjectConfiguration } from "./projects/configuration.js";

export interface BuiltApplication {
  origin: string;
  databaseUrl: string;
  logs(): string;
  deliverDiscord(event: BrowserDiscordEvent): Promise<void>;
  setGitHubConfiguration(input: {
    repositoryId: number;
    commitSha: string;
    rawYaml?: string;
  }): Promise<void>;
}

let MACHINE_KEY = "";

export function setBuiltApplicationMachineKey(value: string): void {
  MACHINE_KEY = value;
}

export interface BuiltApplicationOptions {
  browserAuth?: boolean;
  machineAuth?: boolean;
  databaseProfile?: "fresh" | "legacy";
  registrationMode?: "open" | "invite_only" | "disabled";
  organizationCreation?: "open" | "disabled";
  providerConnections?: boolean;
  githubApprovalRequired?: boolean;
  providerScenario?: BrowserProviderScenario;
  bootstrap?: {
    organizationName: string;
    ownerEmail: string;
    ownerPassword: string;
  };
}

export interface Account {
  name: string;
  email: string;
  password: string;
}

interface TeamExpectation {
  membersPresent: string[];
  membersAbsent: string[];
  invitationsPresent?: string[];
  invitationsAbsent?: string[];
}

interface OrganizationJourneyMember {
  alias: string;
  account: Account;
}

interface OrganizationIsolationJourney {
  owner: OrganizationJourneyMember;
  sharedMember: OrganizationJourneyMember;
  first: {
    name: string;
    member: OrganizationJourneyMember;
    pendingInvitation: string;
  };
  second: {
    name: string;
    member: OrganizationJourneyMember;
    pendingInvitation: string;
  };
}

type StartBuiltApplication = (options?: BuiltApplicationOptions) => Promise<BuiltApplication>;
type StartSourcePaseo = () => Promise<SourcePaseo>;

export class PaseoHub {
  private readonly users = new Map<string, HubUser>();
  private readonly registrations = new Map<string, SourceRegistration>();
  private sourcePaseo: SourcePaseo | undefined;

  constructor(
    private readonly primary: BuiltApplication,
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly requests: APIRequestContext,
    private readonly startApplication: StartBuiltApplication,
    private readonly startSourcePaseo: StartSourcePaseo,
  ) {}

  async visitHome(): Promise<void> {
    await this.page.goto(this.primary.origin);
  }

  async provisionAccount(account: Account): Promise<void> {
    const response = await this.requests.post(`${this.primary.origin}/api/auth/sign-up/email`, {
      data: account,
    });
    expect(response.status()).toBe(200);
  }

  async verifyHttpContractMatrix(): Promise<void> {
    const application = await this.startApplication({ databaseProfile: "legacy" });
    await this.verifyManualApplication(application);
    const webhook = await this.startApplication({ databaseProfile: "legacy" });
    await this.verifyWebhookApplication(webhook);
    await this.verifyLegacyStartupCompatibility();
  }

  private async verifyLegacyStartupCompatibility(): Promise<void> {
    const application = await this.startApplication({
      browserAuth: false,
      machineAuth: false,
    });
    await this.verifyExactContract(application, {
      name: "legacy deployment remains healthy without browser auth",
      request: { path: "/health", method: "GET" },
      expected: { status: 200, body: '{"ok":true}', headers: { "content-type": JSON_TYPE } },
    });
    await this.verifyExactContract(application, {
      name: "browser auth closes independently",
      request: { path: "/api/auth/get-session", method: "GET" },
      expected: {
        status: 503,
        body: '{"error":"auth_unavailable"}',
        headers: { "content-type": JSON_TYPE },
      },
    });
    await this.verifyExactContract(application, {
      name: "machine config closes when machine auth is unavailable",
      request: { path: "/api/configurations/install", method: "POST" },
      expected: {
        status: 503,
        body: '{"error":"auth_unavailable"}',
        headers: { "content-type": JSON_TYPE },
      },
    });
  }

  async expectWelcome(): Promise<void> {
    await expect(this.page.getByRole("heading", { name: "Sign in to Paseo Hub" })).toBeVisible();
  }

  async expectSignedOut(): Promise<void> {
    await this.visitHome();
    await expect(this.page.getByRole("status")).toHaveText("Signed out");
  }

  async expectSignedInAs(email: string): Promise<void> {
    await this.visitHome();
    await expect(this.page.getByRole("status")).toHaveText(`Signed in as ${email}`);
  }

  async expectSignedOutAccountEntry(): Promise<void> {
    await this.visitHome();
    await expect(this.page.getByRole("heading", { name: "Sign in to Paseo Hub" })).toBeVisible();
    await expect(this.page.getByRole("form", { name: "Sign in" })).toBeVisible();
    await expectAccessible(this.page);
  }

  async signUpAs(alias: string, account: Account): Promise<void> {
    const user = await this.user(alias);
    await user.signUp(account);
  }

  async createOrganization(alias: string, name: string): Promise<void> {
    await this.requireUser(alias).createOrganization(name);
  }

  async proveBootstrapJourney(
    account: Account,
    organizationName: string,
    replacementPassword: string,
  ): Promise<void> {
    const application = await this.startApplication({
      databaseProfile: "fresh",
      bootstrap: {
        organizationName,
        ownerEmail: account.email,
        ownerPassword: account.password,
      },
    });
    const context = await this.browser.newContext();
    const page = await context.newPage();
    const user = new HubUser(application.origin, context, page);
    try {
      await user.completeBootstrapJourney(account, replacementPassword, organizationName);
    } finally {
      await context.close();
    }
  }

  async expectApiKeyLifecycle(alias: string): Promise<void> {
    await this.requireUser(alias).expectApiKeyLifecycle();
  }

  async createRunApiKey(alias: string): Promise<string> {
    return await this.requireUser(alias).createRunApiKey();
  }

  async proveInviteOnlyJourney(account: Account): Promise<void> {
    const application = await this.startApplication({
      databaseProfile: "fresh",
      registrationMode: "invite_only",
      organizationCreation: "disabled",
      bootstrap: {
        organizationName: "Invited Organization",
        ownerEmail: "invite-owner@example.com",
        ownerPassword: "temporary-invite-owner-password",
      },
    });
    const ownerContext = await this.browser.newContext();
    const ownerPage = await ownerContext.newPage();
    const owner = new HubUser(application.origin, ownerContext, ownerPage);
    const memberContext = await this.browser.newContext();
    const memberPage = await memberContext.newPage();
    const user = new HubUser(application.origin, memberContext, memberPage);
    try {
      await owner.completeBootstrapJourney(
        {
          name: "Organization Owner",
          email: "invite-owner@example.com",
          password: "temporary-invite-owner-password",
        },
        "permanent-invite-owner-password",
        "Invited Organization",
      );
      const invitationLink = await owner.invite(account.email, "member");
      await user.openInvitation(invitationLink);
      await expect(
        memberPage.getByRole("heading", { name: "Join Invited Organization" }),
      ).toBeVisible();
      await expectAccessible(memberPage);
      const invitationEmail = memberPage
        .getByRole("form", { name: "Create account" })
        .getByLabel("Email");
      await expect(invitationEmail).toHaveValue(account.email);
      await expect(invitationEmail).toHaveAttribute("readonly", "");
      await user.signUpForInvitation(account);
      await user.acceptInvitation();
      await user.expectActiveOrganization("Invited Organization");
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  }

  async proveDisabledRegistrationPresentation(): Promise<void> {
    const application = await this.startApplication({
      databaseProfile: "fresh",
      registrationMode: "disabled",
      organizationCreation: "disabled",
    });
    const context = await this.browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(application.origin);
      await expect(page.getByRole("heading", { name: "Sign in to Paseo Hub" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create an account" })).toHaveCount(0);
      await expect(page.getByText("Paseo Hub isn't accepting new accounts.")).toBeVisible();
      await expectAccessible(page);
      const response = await page.evaluate(async (origin) => {
        const result = await fetch(`${origin}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Blocked Signup",
            email: "blocked-signup@example.com",
            password: "blocked-signup-password",
          }),
        });
        return { status: result.status, body: await result.json() };
      }, application.origin);
      expect(response).toEqual({ status: 403, body: { error: "registration_closed" } });
    } finally {
      await context.close();
    }
  }

  async proveOrganizationCreationDisabled(): Promise<void> {
    const application = await this.startApplication({
      databaseProfile: "fresh",
      registrationMode: "open",
      organizationCreation: "disabled",
    });
    const context = await this.browser.newContext();
    const page = await context.newPage();
    const user = new HubUser(application.origin, context, page);
    try {
      await user.signUp({
        name: "No Organization Owner",
        email: "no-organization-owner@example.com",
        password: "no-organization-owner-password",
      });
      await expect(page.getByRole("heading", { name: "Choose an organization" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create an organization" })).toHaveCount(0);
      await expect(page.getByText("Ask an organization owner to invite you.")).toBeVisible();
      await expectAccessible(page);
      const response = await page.evaluate(async (origin) => {
        const result = await fetch(`${origin}/api/auth/paseo/create-organization`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ name: "Blocked Organization" }),
        });
        return { status: result.status, body: await result.json() };
      }, application.origin);
      expect(response).toEqual({ status: 403, body: { error: "organization_creation_disabled" } });
    } finally {
      await context.close();
    }
  }

  async rejectOrganizationGateCommand(alias: string, name: string): Promise<void> {
    await this.requireUser(alias).rejectOrganizationGateCommand(name);
  }

  async expectDesktopSidebarAndOrganizationMenu(alias: string): Promise<void> {
    await this.requireUser(alias).expectDesktopSidebarAndOrganizationMenu();
  }

  async proveAuthenticationPendingLocksMode(alias: string, account: Account): Promise<void> {
    await this.requireUser(alias).proveAuthenticationPendingLocksMode(account);
  }

  async proveAuthenticationSettlementLocksMode(
    alias: string,
    account: Account,
    organization: string,
  ): Promise<void> {
    await this.requireUser(alias).proveAuthenticationSettlementLocksMode(account, organization);
  }

  async proveOrganizationSwitchUnmountsOldPanel(
    alias: string,
    owningOrganization: string,
    destinationOrganization: string,
    daemonName: string,
  ): Promise<void> {
    const daemonId = await this.seedDaemon(alias, daemonName);
    await this.createAnotherOrganization(alias, destinationOrganization);
    await this.chooseOrganization(alias, owningOrganization);
    const user = this.requireUser(alias);
    await user.expectDaemon(daemonName, daemonId, "Offline");
    await user.expectOrganizationSwitchUnmountsOldPanel(destinationOrganization, daemonName);
  }

  async seedProjectHistory(alias: string, projectSlug: string): Promise<void> {
    await this.queryDatabase(
      this.primary.databaseUrl,
      `with target as (
         select project.id project_id, project.organization_id, "user".id user_id
         from session
         join "user" on "user".id = session.user_id
         join projects project on project.organization_id = session.active_organization_id
         where lower("user".email) = $1 and project.slug = $2
         order by session.expires_at desc limit 1
       ), revision as (
         insert into project_configuration_revisions
           (project_id, organization_id, version, source_kind, source_evidence, raw_yaml,
            normalized_configuration, content_hash, created_by_user_id, validated_at)
         select project_id, organization_id, 1, 'manual', '{"kind":"manual"}'::jsonb,
                'environments: []\ntriggers: []', '{"environments":[],"triggers":[]}'::jsonb,
                'browser-history', user_id, clock_timestamp()
         from target returning id, project_id, organization_id
       ), activated as (
         update projects set active_configuration_revision_id = revision.id
         from revision where projects.id = revision.project_id returning projects.id
       ), receipt as (
         insert into provider_event_receipts
           (organization_id, provider, delivery_id, source, payload, received_at)
         select organization_id, 'manual', concat('browser-history-', project_id),
                'manual.run', '{}'::jsonb, clock_timestamp()
         from revision
         returning id, delivery_id
       ), activity as (
         insert into trigger_runs
           (organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
            configured_trigger_name, status, raw_prompt, prompt, inputs, "values",
            trigger_context, output_context, deadline_at, deadline_kind, outcome,
            created_at, completed_at)
         select revision.organization_id, revision.project_id, revision.id, receipt.id,
                'Browser history', 'succeeded', 'Browser history', 'Browser history',
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                clock_timestamp(), 'whole_run', 'accepted', clock_timestamp(), clock_timestamp()
         from revision
         join receipt on receipt.delivery_id = concat('browser-history-', revision.project_id)
         returning id
       )
       insert into workflow_step_runs
         (trigger_run_id, step_id, ordinal, status, output, started_at, completed_at)
       select id, 'history', 0, 'succeeded', '{"status":"succeeded"}'::jsonb,
              clock_timestamp(), clock_timestamp()
       from activity`,
      [this.requireUser(alias).accountEmail, projectSlug],
    );
  }

  async setDaemonSlug(daemonId: string, slug: string): Promise<void> {
    await this.queryDatabase(
      this.primary.databaseUrl,
      "update daemons set slug = $2 where id = $1",
      [daemonId, slug],
    );
  }

  async runManualInput(input: {
    rawInput: string;
    deliveryKey: string;
    trigger?: string;
    apiKey?: string;
  }): Promise<{ status: number; error?: string; reason?: string }> {
    const response = await this.requests.post(`${this.primary.origin}/api/manual-runs`, {
      headers: {
        ...(input.apiKey === undefined
          ? machineHeaders()
          : { authorization: `Bearer ${input.apiKey}` }),
        "content-type": "application/json",
      },
      data: {
        projectSlug: "default",
        trigger: input.trigger ?? "deploy",
        actor: "alice",
        deliveryKey: input.deliveryKey,
        input: input.rawInput,
      },
    });
    const body = z
      .object({ error: z.string().optional(), reason: z.string().optional() })
      .passthrough()
      .parse(await response.json());
    return {
      status: response.status(),
      ...(body.error === undefined ? {} : { error: body.error }),
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    };
  }

  async createAdminInvitationWithKeyboard(alias: string, email: string): Promise<void> {
    await this.requireUser(alias).createAdminInvitationWithKeyboard(email);
  }

  async navigateToTeamFromMobileSidebar(alias: string): Promise<void> {
    await this.requireUser(alias).navigateToTeamFromMobileSidebar();
  }

  async expectMobileTeamFitsViewport(alias: string): Promise<void> {
    await this.requireUser(alias).expectMobileTeamFitsViewport();
  }

  async expectConnections(alias: string): Promise<void> {
    await this.requireUser(alias).expectConnections();
  }

  async expectEntitlements(alias: string): Promise<void> {
    await this.requireUser(alias).expectEntitlements();
  }

  async openSeatOverrideEditor(
    alias: string,
    input: { max: number; reason: string },
  ): Promise<void> {
    await this.requireUser(alias).openSeatOverrideEditor(input);
  }

  async saveSeatOverride(alias: string, expectedSeats: number): Promise<void> {
    await this.requireUser(alias).saveSeatOverride(expectedSeats);
  }

  async expectInviteRefusedBySeatLimit(
    alias: string,
    email: string,
    expected: { limit: number; current: number },
  ): Promise<void> {
    await this.requireUser(alias).expectInviteRefusedBySeatLimit(email, expected);
  }

  async expectEntitlementsAudit(
    alias: string,
    expected: { actor: string; reason: string },
  ): Promise<void> {
    await this.requireUser(alias).expectEntitlementsAudit(expected);
  }

  async expectMemberConnections(alias: string): Promise<void> {
    await this.requireUser(alias).expectMemberConnections();
  }

  async connectGitHub(alias: string): Promise<void> {
    await this.requireUser(alias).connectGitHub();
  }

  async connectDiscord(alias: string): Promise<void> {
    await this.requireUser(alias).connectDiscord();
  }

  async expectConnectedProviders(
    alias: string,
    expected: { github: string; installationId: string; discord: string; guildId: string },
  ): Promise<void> {
    await this.requireUser(alias).expectConnectedProviders(expected);
  }

  async expectMemberConnectedProviders(
    alias: string,
    expected: { github: string; installationId: string; discord: string; guildId: string },
  ): Promise<void> {
    await this.requireUser(alias).expectMemberConnectedProviders(expected);
  }

  async disconnectProviders(alias: string): Promise<void> {
    await this.requireUser(alias).disconnectProviders();
  }

  async proveConnectionDisconnectLocksOrganizationSwitch(
    alias: string,
    destinationOrganization: string,
  ): Promise<void> {
    await this.requireUser(alias).proveConnectionDisconnectLocksOrganizationSwitch(
      destinationOrganization,
    );
  }

  async proveTenantProviderDispatch(alias: string): Promise<void> {
    await this.chooseOrganization(alias, "Acme");
    const acmeDaemon = await this.connectBrowserDaemon(alias, "Acme", "Acme dispatch daemon");
    await this.chooseOrganization(alias, "Orbit");
    const orbitDaemon = await this.connectBrowserDaemon(alias, "Orbit", "Orbit dispatch daemon");
    const organizations = z
      .array(z.object({ id: z.string(), name: z.string() }))
      .parse(
        await this.queryDatabaseRows(
          this.primary.databaseUrl,
          `select id, name from organization where name in ('Acme', 'Orbit') order by name`,
          [],
        ),
      );
    const acmeId = z.string().parse(organizations.find(({ name }) => name === "Acme")?.id);
    const orbitId = z.string().parse(organizations.find(({ name }) => name === "Orbit")?.id);
    await this.queryDatabase(
      this.primary.databaseUrl,
      `update daemons set slug = 'shared-dispatch' where id = any($1::uuid[])`,
      [[acmeDaemon.daemonId, orbitDaemon.daemonId]],
    );
    await Promise.all([
      this.installTenantProviderConfiguration(acmeId, 42, "acme/widgets", "100"),
      this.installTenantProviderConfiguration(orbitId, 84, "orbit/widgets", "200"),
    ]);

    await this.deliverGitHub("acme-github", 42, "acme/widgets", "alice");
    await this.deliverDiscord("301", "100", "800");
    await this.deliverGitHub("orbit-github", 84, "orbit/widgets", "alice");
    await this.deliverDiscord("302", "200", "800");

    const dispatchesSchema = z.array(
      z.object({
        delivery_id: z.string(),
        trigger_organization_id: z.string(),
        config_organization_id: z.string(),
        machine_organization_id: z.string(),
        daemon_id: z.string(),
        daemon_slug: z.literal("shared-dispatch"),
        execution_id: z.string().uuid(),
      }),
    );
    const dispatches = await retryUntil(
      async () =>
        dispatchesSchema.parse(
          await this.queryDatabaseRows(
            this.primary.databaseUrl,
            `select r.delivery_id,
                    r.organization_id as trigger_organization_id,
                    c.organization_id as config_organization_id,
                    m.org_id as machine_organization_id,
                    d.id::text as daemon_id,
                    d.slug as daemon_slug,
                    e.id::text as execution_id
             from provider_event_receipts r
             join trigger_runs run on run.provider_event_receipt_id = r.id
             join workflow_step_runs step on step.trigger_run_id = run.id
             join agent_executions e on e.workflow_step_run_id = step.id
             join project_configuration_revisions c on c.id = e.configuration_revision_id
             join machines m on m.id = e.machine_id
             join daemons d on d.machine_id = m.id
             where r.delivery_id = any($1::text[])
             order by r.delivery_id`,
            [["acme-github", "discord-301", "orbit-github", "discord-302"]],
          ),
        ),
      (rows) => rows.length === 4,
    );
    expect(dispatches).toEqual([
      dispatchEvidence("acme-github", acmeId, acmeDaemon.daemonId),
      dispatchEvidence("discord-301", acmeId, acmeDaemon.daemonId),
      dispatchEvidence("discord-302", orbitId, orbitDaemon.daemonId),
      dispatchEvidence("orbit-github", orbitId, orbitDaemon.daemonId),
    ]);
    await Promise.all([acmeDaemon.close(), orbitDaemon.close()]);
    await this.chooseOrganization(alias, "Acme");
  }

  async proveDisconnectedProvidersDrop(): Promise<void> {
    await this.deliverGitHub(
      "acme-github-after-disconnect",
      42,
      "acme/widgets",
      "after-disconnect",
    );
    await this.deliverDiscord("303", "100", "800");
    const dropped = z
      .array(
        z.object({
          delivery_id: z.string(),
          organization_id: z.string(),
          dropped_reason: z.string(),
          executions: z.number(),
        }),
      )
      .parse(
        await this.queryDatabaseRows(
          this.primary.databaseUrl,
          `select r.delivery_id, r.organization_id, r.dropped_reason,
                  count(run.id)::integer as executions
           from provider_event_receipts r
           left join trigger_runs run on run.provider_event_receipt_id = r.id
           where r.delivery_id = any($1::text[])
           group by r.id
           order by r.delivery_id`,
          [["acme-github-after-disconnect", "discord-303"]],
        ),
      );
    expect(dropped).toEqual([]);
  }

  async expectMemberConnectionMutationDenied(alias: string): Promise<void> {
    await this.requireUser(alias).expectMemberConnectionMutationDenied();
  }

  async proveProviderNotConfigured(account: Account): Promise<void> {
    const application = await this.startApplication({
      databaseProfile: "fresh",
      providerConnections: false,
    });
    const context = await this.browser.newContext();
    try {
      const user = new HubUser(application.origin, context, await context.newPage());
      await user.signUp(account);
      await user.createOrganization("Unconfigured");
      await user.expectNotConfiguredConnections();
    } finally {
      await context.close();
    }
  }

  async proveManualConfigurationWithoutGitHub(account: Account, rawYaml: string): Promise<void> {
    const application = await this.startApplication({
      databaseProfile: "fresh",
      providerScenario: "discord-only",
    });
    const context = await this.browser.newContext();
    try {
      const page = await context.newPage();
      const user = new HubUser(application.origin, context, page);
      const navigation = new ProjectNavigation(page);
      const configuration = new ProjectConfiguration(page);
      await user.signUp(account);
      await user.createOrganization("Discord only");
      await navigation.openProject("Default");
      await navigation.openProjectSection("Configuration");
      await configuration.saveManualConfiguration(rawYaml);
      await configuration.expectActiveRevision(1);
      await page.waitForLoadState("networkidle");
      expect(application.logs()).not.toContain("github_repositories_unavailable");
    } finally {
      await context.close();
    }
  }

  async proveGitHubApprovalRequired(account: Account): Promise<void> {
    const application = await this.startApplication({
      databaseProfile: "fresh",
      githubApprovalRequired: true,
    });
    const context = await this.browser.newContext();
    try {
      const user = new HubUser(application.origin, context, await context.newPage());
      await user.signUp(account);
      await user.createOrganization("Approval");
      await user.expectGitHubApprovalRequired();
    } finally {
      await context.close();
    }
  }

  async proveConnectionStateBoundaries(account: Account): Promise<void> {
    const application = await this.startApplication({ databaseProfile: "fresh" });
    const context = await this.browser.newContext();
    try {
      const user = new HubUser(application.origin, context, await context.newPage());
      await user.signUp(account);
      await user.createOrganization("State boundaries");
      await user.expectForgedConnectionStateRejected();
      const expired = await user.beginProviderConnection("github");
      await this.queryDatabase(
        application.databaseUrl,
        `update organization_connection_attempts
         set expires_at = clock_timestamp() - interval '1 millisecond'`,
        [],
      );
      await user.expectConnectionReturnUnavailable(expired);
      const replayed = await user.beginProviderConnection("github");
      await user.expectConnectionReturnConnected(replayed, "GitHub connected.");
      await user.expectConnectionReturnUnavailable(replayed);
    } finally {
      await context.close();
    }
  }

  async proveProviderConnectionConflicts(account: Account): Promise<void> {
    const application = await this.startApplication({
      databaseProfile: "fresh",
      providerScenario: "conflict",
    });
    const context = await this.browser.newContext();
    try {
      const user = new HubUser(application.origin, context, await context.newPage());
      await user.signUp(account);
      await user.createOrganization("Conflict Acme");
      await user.connectGitHub();
      await user.connectDiscord();
      await user.createAnotherOrganization("Conflict Orbit");
      await user.expectGitHubConnectionUnavailable();
      await user.expectDiscordConnectionUnavailable();
    } finally {
      await context.close();
    }
  }

  async proveStaleConnectionScopeReplacement(
    account: Account,
    replacement: Account,
  ): Promise<void> {
    const application = await this.startApplication({ databaseProfile: "fresh" });
    const context = await this.browser.newContext();
    try {
      const user = new HubUser(application.origin, context, await context.newPage());
      await user.signUp(account);
      await user.createOrganization("Stale Acme");
      const staleGitHub = await user.beginProviderConnection("github");
      await user.createAnotherOrganization("Stale Orbit");
      await user.expectConnectionReturnConnectedForOrganization(
        staleGitHub,
        "GitHub connected.",
        "Stale Acme",
      );
      await user.chooseOrganization("Stale Orbit");
      await user.expectNoProviderIdentity("acme-inc");

      const staleDiscord = await user.beginProviderConnection("discord");
      await user.signOut();
      await user.signUp(replacement);
      await user.createOrganization("Replacement");
      await user.expectUntrustedConnectionReturnUnavailable(staleDiscord);
      await user.expectNoProviderIdentity("Acme Guild");
    } finally {
      await context.close();
    }
  }

  async proveProviderStartLocksAccountContext(account: Account): Promise<void> {
    const application = await this.startApplication({ databaseProfile: "fresh" });
    const context = await this.browser.newContext();
    try {
      const user = new HubUser(application.origin, context, await context.newPage());
      await user.signUp(account);
      await user.createOrganization("Redirect Acme");
      await user.createAnotherOrganization("Redirect Orbit");
      await user.chooseOrganization("Redirect Acme");
      await user.expectProviderStartLocksAccountContext("github", "Redirect Orbit");
    } finally {
      await context.close();
    }
  }

  async seedSuspendedGitHubConnection(organizationName: string): Promise<void> {
    const client = new Client({ connectionString: this.primary.databaseUrl });
    await client.connect();
    try {
      await client.query(
        `insert into github_connections
           (organization_id, installation_id, slug, account_id, account_login, account_type, status)
         select id, 42, 'github-suspended-inc', '420', 'suspended-inc', 'Organization', 'suspended'
         from organization where name = $1`,
        [organizationName],
      );
    } finally {
      await client.end();
    }
  }

  async expectSuspendedGitHubConnection(alias: string): Promise<void> {
    await this.requireUser(alias).expectSuspendedGitHubConnection();
  }

  async navigateToConnectionsFromMobileSidebar(alias: string): Promise<void> {
    await this.requireUser(alias).navigateToConnectionsFromMobileSidebar();
  }

  async copyInvitationAndExpectFeedback(
    alias: string,
    email: string,
    invitationLink: string,
  ): Promise<void> {
    await this.requireUser(alias).copyInvitationAndExpectFeedback(email, invitationLink);
  }

  async expectTeamDestructiveConfirmations(
    alias: string,
    memberName: string,
    invitationEmail: string,
  ): Promise<void> {
    await this.requireUser(alias).expectTeamDestructiveConfirmations(memberName, invitationEmail);
  }

  async createAnotherOrganization(alias: string, name: string): Promise<void> {
    await this.requireUser(alias).createAnotherOrganization(name);
  }

  async chooseOrganization(alias: string, name: string): Promise<void> {
    await this.requireUser(alias).chooseOrganization(name);
  }

  async rejectOrganizationSwitchAndInvitation(
    alias: string,
    organization: string,
    email: string,
  ): Promise<void> {
    await this.requireUser(alias).rejectOrganizationSwitchAndInvitation(organization, email);
  }

  async proveInvitationLocksOrganizationSwitch(
    alias: string,
    organization: string,
    email: string,
  ): Promise<void> {
    await this.requireUser(alias).proveInvitationLocksOrganizationSwitch(organization, email);
  }

  async inviteMember(alias: string, email: string, role: "admin" | "member"): Promise<string> {
    return this.requireUser(alias).invite(email, role);
  }

  async openInvitation(alias: string, link: string): Promise<void> {
    const user = await this.user(alias);
    await user.openInvitation(link);
  }

  async acceptInvitation(alias: string): Promise<void> {
    await this.requireUser(alias).acceptInvitation();
  }

  async joinInvitationAs(alias: string, account: Account, link: string): Promise<void> {
    await this.openInvitation(alias, link);
    await this.requireUser(alias).signUpForInvitation(account);
    await this.requireUser(alias).acceptInvitationWithSignOutLocked();
  }

  async joinInvitation(alias: string, link: string): Promise<void> {
    await this.requireUser(alias).openInvitation(link);
    await this.requireUser(alias).acceptInvitation();
  }

  async addNewMember(ownerAlias: string, memberAlias: string, account: Account): Promise<void> {
    const invitation = await this.inviteMember(ownerAlias, account.email, "member");
    await this.joinInvitationAs(memberAlias, account, invitation);
  }

  async addExistingMember(ownerAlias: string, memberAlias: string, email: string): Promise<void> {
    const invitation = await this.inviteMember(ownerAlias, email, "member");
    await this.joinInvitation(memberAlias, invitation);
  }

  async proveInvitationSurvivesSessionExpiry(
    ownerAlias: string,
    owner: Account,
    inviteeAlias: string,
    invitee: Account,
    organization: string,
  ): Promise<void> {
    await this.signUpAs(ownerAlias, owner);
    await this.createOrganization(ownerAlias, organization);
    const invitation = await this.inviteMember(ownerAlias, invitee.email, "member");
    await this.openInvitation(inviteeAlias, invitation);
    const user = this.requireUser(inviteeAlias);
    await user.signUpForInvitation(invitee);
    await this.expireSession(inviteeAlias);
    await user.acceptInvitationAfterSessionExpiry(invitee, invitation, organization);
  }

  async startDaemonRegistration(alias: string): Promise<void> {
    this.sourcePaseo ??= await this.startSourcePaseo();
    const registration = await this.sourcePaseo.beginRegistration(this.primary.origin, {
      loseFirstApprovedPollResponse: true,
      loseFirstEnrollmentResponse: true,
    });
    this.registrations.set(alias, registration);
    await this.requireUser(alias).openDaemonApproval(
      registration.verificationUrl,
      undefined,
      "Acme",
    );
  }

  async approveDaemon(alias: string, displayName: string): Promise<string> {
    const registration = this.requireRegistration(alias);
    const user = this.requireUser(alias);
    await user.approveDaemon(displayName);
    await user.returnToDaemonsWithoutDocumentNavigation();
    const result = await registration.complete();
    expect(this.requireSourcePaseo().registrationSecretsAbsentFrom(this.primary.logs())).toBe(true);
    const daemonId = z.string().uuid().parse(result["daemonId"]);
    await expect
      .poll(async () => {
        const rows = await this.queryDatabaseRows(
          this.primary.databaseUrl,
          "select presence from daemons where id = $1",
          [daemonId],
        );
        return z.array(z.object({ presence: z.string() })).parse(rows)[0]?.presence;
      })
      .toBe("connected");
    return daemonId;
  }

  expectRegistrationResponseRecovery(): void {
    const source = this.requireSourcePaseo();
    expect(source.approvedPollReplayEvidence()).toEqual({
      attempts: 2,
      sameAuthority: true,
    });
    expect(source.enrollmentReplayEvidence()).toEqual({
      attempts: 2,
      sameCeremony: true,
    });
  }

  async expectDaemon(
    alias: string,
    displayName: string,
    daemonId: string,
    state: "Connected" | "Offline" | "Revoked",
  ): Promise<void> {
    await this.requireUser(alias).expectDaemon(displayName, daemonId, state);
  }

  async renameDaemon(alias: string, currentName: string, displayName: string): Promise<void> {
    await this.requireUser(alias).renameDaemon(currentName, displayName);
  }

  async revokeDaemon(alias: string, displayName: string): Promise<void> {
    await this.requireUser(alias).revokeDaemon(displayName);
    const source = this.requireSourcePaseo();
    await source.waitForRelationshipState("revoked");
    expect(await source.reconnectWithRevokedCredential()).toBe(403);
    await source.restart();
    await source.waitForRelationshipState("revoked");
  }

  async proveDaemonIsolation(
    alias: string,
    owningOrganization: string,
    foreignOrganization: string,
    displayName: string,
  ): Promise<void> {
    await this.createAnotherOrganization(alias, foreignOrganization);
    await this.requireUser(alias).expectDaemonAbsent(displayName);
    await this.chooseOrganization(alias, owningOrganization);
  }

  async expectDaemonReadOnly(alias: string, displayName: string): Promise<void> {
    await this.requireUser(alias).expectDaemonReadOnly(displayName);
  }

  async navigateToDaemonsFromMobileSidebar(alias: string): Promise<void> {
    await this.requireUser(alias).navigateToDaemonsFromMobileSidebar();
  }

  async proveDaemonAccessBoundaries(
    ownerAlias: string,
    memberAlias: string,
    memberAccount: Account,
    displayName: string,
  ): Promise<void> {
    await this.proveDaemonIsolation(ownerAlias, "Acme", "Orbit", displayName);
    await this.addNewMember(ownerAlias, memberAlias, memberAccount);
    await this.expectDaemonReadOnly(memberAlias, displayName);
  }

  async proveDaemonBrowserIdentityBoundary(
    alias: string,
    daemonReplacement: Account,
    approvalReplacement: Account,
    displayName: string,
  ): Promise<void> {
    const user = this.requireUser(alias);
    const daemonId = await this.seedDaemon(alias, displayName);
    await user.expectDaemon(displayName, daemonId, "Offline");
    await user.createAnotherOrganizationWithoutDisclosure("Orbit", displayName);
    await user.expectDaemonAbsent(displayName);
    const registration = await this.startRegistrationRequest("Scoped registration");
    await user.openDaemonApproval(registration.verificationUrl, "Scoped registration", "Orbit");
    await user.chooseOrganization("Acme");
    await user.expectDaemon(displayName, daemonId, "Offline");
    await user.replaceDaemonAccountWithoutDisclosure(daemonReplacement, "Replacement", displayName);
    const replacementDaemonId = await this.seedDaemon(alias, "replacement-studio");
    await user.expectDaemon("replacement-studio", replacementDaemonId, "Offline");
    const replacementRegistration = await this.startRegistrationRequest("Replacement request");
    await user.openDaemonApproval(
      replacementRegistration.verificationUrl,
      "Replacement request",
      "Replacement",
    );
    await user.replaceApprovalAccountWithoutDisclosure(
      approvalReplacement,
      "Final organization",
      "Replacement",
    );
    await user.returnToProjects();
    const finalDaemonId = await this.seedDaemon(alias, "final-studio");
    await user.expectDaemon("final-studio", finalDaemonId, "Offline");
    await this.expireSession(alias);
    await user.attemptStaleRename("final-studio", "leaked-studio");
  }

  async proveDaemonCommandLocksAccountContext(alias: string): Promise<void> {
    const user = this.requireUser(alias);
    await this.chooseOrganization(alias, "Acme");

    const renameDaemonId = await this.seedDaemon(alias, "rename-pending-studio");
    await user.expectDaemon("rename-pending-studio", renameDaemonId, "Offline");
    await user.expectRenameDaemonLocksAccountContext(
      "rename-pending-studio",
      "renamed-pending-studio",
      "Orbit",
    );

    const revokeDaemonId = await this.seedDaemon(alias, "revoke-pending-studio");
    await user.expectDaemon("revoke-pending-studio", revokeDaemonId, "Offline");
    await user.expectRevokeDaemonLocksAccountContext(
      "revoke-pending-studio",
      revokeDaemonId,
      "Orbit",
    );

    const registration = await this.startRegistrationRequest("Approve Pending Studio");
    await user.openDaemonApproval(registration.verificationUrl, "Approve Pending Studio", "Acme");
    await user.expectRegistrationDecisionLocksAccountContext(
      "Approve Pending Studio",
      "approved",
      "Orbit",
    );
  }

  async proveDaemonRenameConflict(alias: string): Promise<void> {
    await this.seedDaemon(alias, "reserved-studio");
    await this.seedDaemon(alias, "rename-source-studio");
    await this.requireUser(alias).expectDaemonRenameConflict(
      "rename-source-studio",
      "reserved-studio",
    );
  }

  async denyRegistration(alias: string, displayName: string): Promise<void> {
    const request = await this.startRegistrationRequest(displayName);
    await this.requireUser(alias).openDaemonApproval(request.verificationUrl, displayName, "Acme");
    await this.requireUser(alias).denyDaemon();
    const poll = await this.requests.post(`${this.primary.origin}/api/device-authorizations/poll`, {
      data: { deviceCode: request.deviceCode },
    });
    expect(await poll.json()).toEqual(expect.objectContaining({ status: "denied" }));
    this.expectRegistrationSecretsAbsentFromLogs(request.deviceCode);
    await this.requireUser(alias).expectRegistrationUnavailable(request.verificationUrl);
  }

  async expireRegistration(alias: string, displayName: string): Promise<void> {
    const request = await this.startRegistrationRequest(displayName);
    await this.queryDatabase(
      this.primary.databaseUrl,
      "update daemon_device_authorizations set expires_at = now() - interval '1 minute'",
      [],
    );
    await this.requireUser(alias).expectRegistrationUnavailable(request.verificationUrl);
  }

  async establishOrganizationIsolation(journey: OrganizationIsolationJourney): Promise<void> {
    await this.signUpAs(journey.owner.alias, journey.owner.account);
    await this.createOrganization(journey.owner.alias, journey.first.name);
    await this.addNewMember(
      journey.owner.alias,
      journey.sharedMember.alias,
      journey.sharedMember.account,
    );
    await this.addNewMember(
      journey.owner.alias,
      journey.first.member.alias,
      journey.first.member.account,
    );
    await this.inviteMember(journey.owner.alias, journey.first.pendingInvitation, "member");
    await this.createAnotherOrganization(journey.owner.alias, journey.second.name);
    await this.addExistingMember(
      journey.owner.alias,
      journey.sharedMember.alias,
      journey.sharedMember.account.email,
    );
    await this.addNewMember(
      journey.owner.alias,
      journey.second.member.alias,
      journey.second.member.account,
    );
    await this.inviteMember(journey.owner.alias, journey.second.pendingInvitation, "member");
  }

  async expectActiveOrganization(alias: string, name: string): Promise<void> {
    await this.requireUser(alias).expectActiveOrganization(name);
  }

  async expectMemberBoundary(alias: string, organizationName: string): Promise<void> {
    await this.requireUser(alias).expectMemberBoundary(organizationName);
  }

  async changeMemberRole(
    actorAlias: string,
    memberName: string,
    role: "owner" | "admin" | "member",
  ): Promise<void> {
    await this.requireUser(actorAlias).changeMemberRole(memberName, role);
  }

  async proveAdminInvitation(alias: string, email: string): Promise<void> {
    await this.requireUser(alias).invite(email, "member");
  }

  async expectOrganizationTeam(alias: string, expected: TeamExpectation): Promise<void> {
    await this.requireUser(alias).expectTeam(expected);
  }

  async signOut(alias: string): Promise<void> {
    await this.requireUser(alias).signOut();
  }

  async establishLoadedTeam(
    alias: string,
    account: Account,
    organization: string,
    pendingInvitation: string,
  ): Promise<void> {
    await this.signUpAs(alias, account);
    await this.createOrganization(alias, organization);
    await this.inviteMember(alias, pendingInvitation, "member");
  }

  async expireSession(alias: string): Promise<void> {
    await this.queryDatabase(
      this.primary.databaseUrl,
      `update session set expires_at = now() - interval '1 minute'
       from "user" where session.user_id = "user".id and lower("user".email) = $1`,
      [this.requireUser(alias).accountEmail],
    );
  }

  private async seedDaemon(alias: string, displayName: string): Promise<string> {
    const daemonId = randomUUID();
    const machineId = randomUUID();
    await this.queryDatabase(
      this.primary.databaseUrl,
      `insert into machines (id, org_id, source, status)
       select $1, session.active_organization_id,
              jsonb_build_object('kind', 'daemon', 'daemonId', $2::text), 'alive'
       from session join "user" on "user".id = session.user_id
       where lower("user".email) = $3 and session.expires_at > now()`,
      [machineId, daemonId, this.requireUser(alias).accountEmail],
    );
    await this.queryDatabase(
      this.primary.databaseUrl,
      `insert into daemons
         (id, idempotency_key, enrollment_verifier, slug, machine_id, organization_id, server_id,
          daemon_public_key, credential_verifier, scopes, registration_method, status)
       values ($1, $2, $3, $4, $5, (select org_id from machines where id = $5),
               'browser-boundary', 'public-key',
               'credential-verifier', '["hub.execution.*"]'::jsonb, 'device', 'active')`,
      [daemonId, randomUUID(), randomUUID(), displayName, machineId],
    );
    return daemonId;
  }

  async revokeActiveMembership(alias: string): Promise<void> {
    await this.queryDatabase(
      this.primary.databaseUrl,
      `delete from member using "user"
       where member.user_id = "user".id and lower("user".email) = $1
         and member.organization_id in (
           select active_organization_id from session
           where user_id = "user".id and active_organization_id is not null
         )`,
      [this.requireUser(alias).accountEmail],
    );
  }

  async attemptInvitationFromLoadedTeam(alias: string, email: string): Promise<void> {
    await this.requireUser(alias).attemptInvitation(email);
  }

  async expectSignedOutWithoutCachedTeam(alias: string, cachedValues: string[]): Promise<void> {
    await this.requireUser(alias).expectCachedTeamCleared("signedOut", cachedValues);
  }

  async expectOrganizationRequiredWithoutCachedTeam(
    alias: string,
    cachedValues: string[],
  ): Promise<void> {
    await this.requireUser(alias).expectCachedTeamCleared("organizationRequired", cachedValues);
  }

  private async user(alias: string): Promise<HubUser> {
    const existing = this.users.get(alias);
    if (existing !== undefined) return existing;
    let context: BrowserContext;
    let page: Page;
    if (this.users.size === 0) {
      context = this.page.context();
      page = this.page;
    } else {
      context = await this.browser.newContext();
      page = await context.newPage();
    }
    const user = new HubUser(this.primary.origin, context, page);
    this.users.set(alias, user);
    return user;
  }

  private requireUser(alias: string): HubUser {
    const user = this.users.get(alias);
    if (user === undefined) throw new Error(`unknown browser account: ${alias}`);
    return user;
  }

  private requireRegistration(alias: string): SourceRegistration {
    const registration = this.registrations.get(alias);
    if (registration === undefined) throw new Error(`no daemon registration for ${alias}`);
    return registration;
  }

  private requireSourcePaseo(): SourcePaseo {
    if (this.sourcePaseo === undefined) throw new Error("Source-built Paseo has not started");
    return this.sourcePaseo;
  }

  private expectRegistrationSecretsAbsentFromLogs(deviceCode: string): void {
    const enrollmentToken = createHash("sha256")
      .update("paseo-device-enrollment\0")
      .update(deviceCode)
      .digest("base64url");
    expect(this.primary.logs()).not.toContain(deviceCode);
    expect(this.primary.logs()).not.toContain(enrollmentToken);
  }

  private async startRegistrationRequest(displayName: string) {
    const response = await this.requests.post(`${this.primary.origin}/api/device-authorizations/`, {
      data: { slug: displayName },
    });
    expect(response.status()).toBe(201);
    const request = z
      .object({
        deviceCode: z.string(),
        userCode: z.string(),
        verificationUriComplete: z.string().url(),
      })
      .parse(await response.json());
    return { ...request, verificationUrl: request.verificationUriComplete };
  }

  private async connectBrowserDaemon(
    alias: string,
    organizationName: string,
    displayName: string,
  ): Promise<ContractDaemon> {
    const registration = await this.startRegistrationRequest(displayName);
    const user = this.requireUser(alias);
    await user.openDaemonApproval(registration.verificationUrl, displayName, organizationName);
    await user.approveDaemon(displayName);
    const poll = await this.requests.post(`${this.primary.origin}/api/device-authorizations/poll`, {
      data: { deviceCode: registration.deviceCode },
    });
    expect(poll.status()).toBe(200);
    const enrollmentToken = z
      .object({ status: z.literal("approved"), enrollmentToken: z.string() })
      .parse(await poll.json()).enrollmentToken;
    const daemon = new ContractDaemon(this.primary, this.requests, displayName);
    await daemon.enroll(enrollmentToken);
    await daemon.connect();
    return daemon;
  }

  private async installTenantProviderConfiguration(
    organizationId: string,
    repositoryId: number,
    repo: string,
    guildId: string,
  ): Promise<void> {
    const database = await createDatabase(this.primary.databaseUrl);
    try {
      const project = await database.findProjectBySlugForOrganization(organizationId, "default");
      if (project === undefined) throw new Error("default project unavailable");
      const daemon = await database.findDaemonBySlugForOrganization(
        organizationId,
        "shared-dispatch",
      );
      if (daemon === undefined) throw new Error("dispatch daemon unavailable");
      const [owner] = z.array(z.object({ user_id: z.string() })).parse(
        await this.queryDatabaseRows(
          this.primary.databaseUrl,
          `select user_id from member
             where organization_id = $1 and role = 'owner'
             order by id limit 1`,
          [organizationId],
        ),
      );
      if (owner === undefined) throw new Error("organization owner unavailable");
      const github = await database.findGitHubConnection(repositoryId);
      if (github === undefined || github.organizationId !== organizationId) {
        throw new Error("GitHub connection unavailable");
      }
      await database.upsertGitHubRepositories(organizationId, github.id, [
        {
          repositoryId,
          fullName: repo,
          defaultBranch: "main",
        },
      ]);
      await database.setProjectGitHubConfigurationSource({
        projectId: project.id,
        githubConnectionId: github.id,
        githubRepositoryId: repositoryId,
        githubRepositoryFullName: repo,
        githubDefaultBranch: "main",
        automaticDeploymentEnabled: true,
        userId: owner.user_id,
      });
      const discord = await database.findDiscordConnection(guildId);
      if (discord === undefined || discord.organizationId !== organizationId) {
        throw new Error("Discord connection unavailable");
      }

      const store = new ProjectConfigurationStore(database, project.id);
      const revision = await store.insertManualRevision({
        rawYaml: null,
        rawConfiguration: providerDispatchConfiguration(repo, guildId),
        userId: owner.user_id,
        sourceEvidence: { kind: "browser-fixture", userId: owner.user_id },
      });
      await store.activate(revision.id);
    } finally {
      await database.close();
    }
  }

  private async deliverGitHub(
    deliveryId: string,
    installationId: number,
    repo: string,
    actor: string,
  ): Promise<void> {
    const payload = JSON.stringify(githubIssueCommentPayload(installationId, repo, actor));
    const signature =
      "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
    const response = await this.requests.post(`${this.primary.origin}/webhook`, {
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signature,
      },
      data: Buffer.from(payload),
    });
    expect(response.status()).toBe(200);
  }

  private deliverDiscord(messageId: string, guildId: string, authorId: string): Promise<void> {
    return this.primary.deliverDiscord({
      guildId,
      channelId: `${guildId}0`,
      messageId,
      authorId,
      authorUsername: authorId,
      content: "<@900> run tenant dispatch",
    });
  }

  private async queryDatabase(databaseUrl: string, text: string, values: unknown[]): Promise<void> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(text, values);
    } finally {
      await client.end();
    }
  }

  private async queryDatabaseRows(
    databaseUrl: string,
    text: string,
    values: unknown[],
  ): Promise<unknown[]> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return (await client.query(text, values)).rows;
    } finally {
      await client.end();
    }
  }

  private async verifyManualApplication(application: BuiltApplication): Promise<void> {
    await this.verifyExactContracts(application, manualFailureContracts());
    await this.verifyLegacyCompletionCallbackAbsent(application);
    await this.verifyDocumentAndAssetContracts(application);
    await this.verifyAuthContracts(application);
    await this.verifyOrganizationPostOriginBoundary(application);
    await this.verifyHostileOriginBoundary(application);

    const enrollmentToken = await this.issueEnrollmentToken(application);
    const daemon = new ContractDaemon(application, this.requests);
    await daemon.enroll(enrollmentToken);
    await daemon.connect();
    const versionId = await this.installManualConfiguration(application, daemon.slug);
    const execution = await this.runManualExecution(application, versionId);
    await this.completeExecution(application, execution.executionId, daemon);
    await daemon.expectUnauthorizedRevocation();
    await daemon.revoke();
    await this.expectEnrollmentReplayDenied(application, enrollmentToken);
  }

  private async verifyWebhookApplication(application: BuiltApplication): Promise<void> {
    await this.verifyExactContracts(application, WEBHOOK_SOURCE_CONTRACTS);
    const payload = JSON.stringify({
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "acme/widgets" },
    });
    const signature =
      "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
    await this.verifyExactContract(application, {
      name: "active webhook accepts a signed delivery",
      request: {
        path: "/webhook",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "built-contract-delivery",
          "x-github-event": "issue_comment",
          "x-hub-signature-256": signature,
        },
        body: payload,
      },
      expected: { status: 200, body: "OK", headers: { "content-type": TEXT_TYPE } },
    });
  }

  private async verifyExactContracts(
    application: BuiltApplication,
    contracts: readonly HttpContract[],
  ): Promise<void> {
    for (const contract of contracts) await this.verifyExactContract(application, contract);
  }

  private async verifyExactContract(
    application: BuiltApplication,
    contract: HttpContract,
  ): Promise<void> {
    const response = await this.requests.fetch(`${application.origin}${contract.request.path}`, {
      method: contract.request.method,
      ...(contract.request.headers === undefined ? {} : { headers: contract.request.headers }),
      ...(contract.request.body === undefined ? {} : { data: Buffer.from(contract.request.body) }),
    });
    expect(response.status(), contract.name).toBe(contract.expected.status);
    expect(await response.text(), contract.name).toBe(contract.expected.body);
    for (const [name, value] of Object.entries(contract.expected.headers)) {
      expect(response.headers()[name], contract.name).toBe(value);
    }
  }

  private async verifyDocumentAndAssetContracts(application: BuiltApplication): Promise<void> {
    const home = await this.requests.get(application.origin);
    expect(home.status()).toBe(200);
    expect(home.headers()["content-type"]).toBe(HTML_TYPE);
    const document = await home.text();
    // The server render precedes session resolution, so the shell it paints must not
    // claim either signed-in or signed-out.
    expect(document).toContain("Loading Paseo Hub");
    expect(document).not.toContain("Sign in to Paseo Hub");
    const assetPath = z.string().parse(document.match(/\/assets\/[A-Za-z0-9._-]+\.css/u)?.[0]);
    const asset = await this.requests.get(`${application.origin}${assetPath}`);
    expect(asset.status()).toBe(200);
    expect(asset.headers()["content-type"]).toBe("text/css; charset=utf-8");
    expect(asset.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await asset.body()).byteLength).toBeGreaterThan(0);
    await this.verifyExactContract(application, {
      name: "missing asset",
      request: { path: "/assets/missing.css", method: "GET" },
      expected: { status: 404, body: "Not Found", headers: { "content-type": TEXT_TYPE } },
    });
  }

  private async verifyAuthContracts(application: BuiltApplication): Promise<void> {
    await this.verifyExactContract(application, {
      name: "signed-out session",
      request: { path: "/api/auth/get-session", method: "GET" },
      expected: { status: 200, body: "null", headers: { "content-type": JSON_TYPE } },
    });
    const account = {
      name: "Contract Operator",
      email: "contract@example.com",
      password: "contract-password",
    };
    const signUp = await this.requests.post(`${application.origin}/api/auth/sign-up/email`, {
      data: account,
    });
    expect(signUp.status()).toBe(200);
    expect(signUp.headers()["content-type"]).toBe(JSON_TYPE);
    expect(signUp.headers()["set-cookie"]).toContain("better-auth.session_token=");
    expect(await signUp.json()).toEqual({
      token: expect.any(String),
      user: expect.objectContaining({ name: account.name, email: account.email }),
    });
    const session = await this.requests.get(`${application.origin}/api/auth/get-session`);
    expect(session.status()).toBe(200);
    expect(await session.json()).toEqual({
      session: expect.objectContaining({ token: expect.any(String), userId: expect.any(String) }),
      user: expect.objectContaining({ name: account.name, email: account.email }),
    });
    const rejected = await this.requests.post(`${application.origin}/api/auth/sign-in/email`, {
      headers: { origin: application.origin },
      data: { email: account.email, password: "wrong-password" },
    });
    expect(rejected.status()).toBe(401);
    expect(rejected.headers()["content-type"]).toBe(JSON_TYPE);
    expect(await rejected.json()).toEqual({
      code: "INVALID_EMAIL_OR_PASSWORD",
      message: "Invalid email or password",
    });
  }

  private async verifyOrganizationPostOriginBoundary(application: BuiltApplication): Promise<void> {
    const sameOrigin = { origin: application.origin, "sec-fetch-site": "same-origin" };
    const post = (path: string, data: unknown, headers: Record<string, string> = sameOrigin) =>
      this.requests.post(`${application.origin}${path}`, { headers, data });

    expect((await post("/api/auth/organization/create", {})).status()).toBe(404);

    const originFailures = [
      {
        name: "hostile origin",
        headers: { origin: HOSTILE_ORIGIN },
        error: { message: "Invalid origin", code: "INVALID_ORIGIN" },
      },
      {
        name: "missing origin",
        headers: {},
        error: { message: "Missing or null Origin", code: "MISSING_OR_NULL_ORIGIN" },
      },
      {
        name: "null origin",
        headers: { origin: "null" },
        error: { message: "Missing or null Origin", code: "MISSING_OR_NULL_ORIGIN" },
      },
      {
        name: "cross-site Fetch Metadata",
        headers: { origin: application.origin, "sec-fetch-site": "cross-site" },
        error: {
          message: "Cross-site navigation login blocked. This request appears to be a CSRF attack.",
          code: "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
        },
      },
    ];
    for (const path of ORGANIZATION_POST_PATHS) {
      for (const boundary of originFailures) {
        const response = await post(path, {}, boundary.headers);
        expect(response.status(), `${boundary.name}: ${path}`).toBe(403);
        expect(await response.json(), `${boundary.name}: ${path}`).toEqual(boundary.error);
      }
    }
  }

  private async verifyHostileOriginBoundary(application: BuiltApplication): Promise<void> {
    await this.verifyExactContract(application, {
      name: "hostile origin cannot create an auth session",
      request: {
        path: "/api/auth/sign-up/email",
        method: "POST",
        headers: { "content-type": "application/json", origin: HOSTILE_ORIGIN },
        body: JSON.stringify({
          name: "Hostile Operator",
          email: "hostile@example.com",
          password: "hostile-password",
        }),
      },
      expected: {
        status: 403,
        body: '{"message":"Invalid origin","code":"INVALID_ORIGIN"}',
        headers: { "content-type": JSON_TYPE },
      },
    });
    await this.issueEnrollmentToken(application, {
      ...machineHeaders(),
      origin: HOSTILE_ORIGIN,
    });

    for (const contract of [
      {
        name: "Better Auth rejects a hostile cookie origin",
        headers: { "content-type": "application/json", origin: HOSTILE_ORIGIN },
        body: '{"message":"Invalid origin","code":"INVALID_ORIGIN"}',
      },
      {
        name: "Better Auth rejects a missing cookie origin",
        headers: { "content-type": "application/json" },
        body: '{"message":"Missing or null Origin","code":"MISSING_OR_NULL_ORIGIN"}',
      },
      {
        name: "Better Auth rejects a null cookie origin",
        headers: { "content-type": "application/json", origin: "null" },
        body: '{"message":"Missing or null Origin","code":"MISSING_OR_NULL_ORIGIN"}',
      },
    ]) {
      await this.verifyExactContract(application, {
        name: contract.name,
        request: {
          path: "/api/auth/sign-out",
          method: "POST",
          headers: contract.headers,
          body: "{}",
        },
        expected: { status: 403, body: contract.body, headers: { "content-type": JSON_TYPE } },
      });
    }
  }

  private async issueEnrollmentToken(
    application: BuiltApplication,
    headers: Record<string, string> = machineHeaders(),
  ): Promise<string> {
    const response = await this.requests.post(
      `${application.origin}/api/daemons/enrollment-tokens`,
      { headers },
    );
    expect(response.status()).toBe(201);
    expect(response.headers()["content-type"]).toBe(JSON_TYPE);
    const body = z
      .object({ token: z.string().min(1), expiresAt: z.string().datetime() })
      .strict()
      .parse(await response.json());
    return body.token;
  }

  private async installManualConfiguration(
    application: BuiltApplication,
    daemonSlug: string,
  ): Promise<string> {
    const response = await this.requests.post(`${application.origin}/api/configurations/install`, {
      headers: machineHeaders(),
      data: {
        projectSlug: "default",
        yaml: manualConfiguration(daemonSlug),
      },
    });
    expect(response.status()).toBe(201);
    expect(response.headers()["content-type"]).toBe(JSON_TYPE);
    const body = z
      .object({
        projectSlug: z.literal("default"),
        versionId: z.string().uuid(),
        version: z.literal(1),
        active: z.literal(true),
      })
      .strict()
      .parse(await response.json());
    return body.versionId;
  }

  private async runManualExecution(
    application: BuiltApplication,
    versionId: string,
  ): Promise<{ executionId: string }> {
    const response = await this.requests.post(`${application.origin}/api/manual-runs`, {
      headers: machineHeaders(),
      data: {
        projectSlug: "default",
        expectedVersionId: versionId,
        trigger: "deploy",
        actor: "contract-operator",
        deliveryKey: "built-contract-run",
        input: { service: "api" },
      },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe(JSON_TYPE);
    const body = z
      .object({
        deliveryKey: z.literal("built-contract-run"),
        providerEventReceiptId: z.string().uuid(),
        triggerRunId: z.string().uuid(),
        configuredTriggerName: z.literal("deploy"),
        workflowStatus: z.literal("running"),
      })
      .strict()
      .parse(await response.json());
    const execution = await retryUntil(
      async () =>
        z.array(z.object({ id: z.string().uuid() })).parse(
          await this.queryDatabaseRows(
            application.databaseUrl,
            `select execution.id
               from agent_executions execution
               join workflow_step_runs step on step.agent_execution_id = execution.id
               join trigger_runs run on run.id = step.trigger_run_id
               where run.provider_event_receipt_id = $1`,
            [body.providerEventReceiptId],
          ),
        ),
      (rows) => rows.length === 1,
    );
    return { executionId: execution[0]!.id };
  }

  private async completeExecution(
    application: BuiltApplication,
    executionId: string,
    daemon: ContractDaemon,
  ): Promise<void> {
    const capability = daemon.executionCapability(executionId);
    const client = new McpClient({ name: "paseo-hub-browser-contract", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(capability.url), {
      requestInit: { headers: capability.headers },
    });
    try {
      // The SDK's getter is typed `string | undefined` while its Transport interface uses an
      // exact-optional `sessionId?: string`; the runtime class is the SDK's official transport.
      // @ts-expect-error upstream SDK exactOptionalPropertyTypes mismatch
      await client.connect(transport);
      const result = await client.callTool({ name: "finish_execution", arguments: {} });
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([{ type: "text", text: "Execution finished" }]);
    } finally {
      await client.close();
    }
  }

  private async expectEnrollmentReplayDenied(
    application: BuiltApplication,
    enrollmentToken: string,
  ): Promise<void> {
    const response = await this.requests.post(`${application.origin}/api/daemons/enroll`, {
      headers: {
        authorization: `Bearer ${enrollmentToken}`,
        "content-type": "application/json",
      },
      data: daemonEnrollment(randomUUID(), randomUUID()),
    });
    expect(response.status()).toBe(401);
    expect(await response.text()).toBe('{"error":"invalid enrollment token"}');
    expect(response.headers()["content-type"]).toBe(JSON_TYPE);
  }

  private async verifyLegacyCompletionCallbackAbsent(application: BuiltApplication): Promise<void> {
    const response = await this.requests.post(
      `${application.origin}/agent-executions/00000000-0000-4000-8000-000000000000/done`,
    );
    expect(response.status(), "legacy execution completion callback is unavailable").toBe(404);
  }
}

class HubUser {
  private email: string | undefined;
  private readonly navigation: ProjectNavigation;

  constructor(
    private readonly origin: string,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {
    this.navigation = new ProjectNavigation(page);
  }

  async signUp(account: Account): Promise<void> {
    this.email = account.email.toLowerCase();
    if (this.page.url() === "about:blank") await this.page.goto(this.origin);
    await this.submitSignUp(account);
    await expect(this.page.getByRole("heading", { name: "Choose an organization" })).toBeVisible();
  }

  async completeBootstrapJourney(
    account: Account,
    replacementPassword: string,
    organizationName: string,
  ): Promise<void> {
    await this.page.goto(this.origin);
    const signIn = this.page.getByRole("form", { name: "Sign in" });
    await signIn.getByLabel("Email").fill(account.email);
    await signIn.getByLabel("Password").fill(account.password);
    await signIn.getByRole("button", { name: "Sign in" }).click();
    await expect(this.page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await expectAccessible(this.page);

    const change = this.page.getByRole("form", { name: "Choose a new password" });
    await change.getByLabel("Current password").fill(account.password);
    await change
      .getByRole("textbox", { name: "New password", exact: true })
      .fill(replacementPassword);
    await change.getByLabel("Confirm new password").fill(replacementPassword);
    await change.getByRole("button", { name: "Save password" }).click();
    await expect(this.page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await this.expectActiveOrganization(organizationName);
  }

  async expectApiKeyLifecycle(): Promise<void> {
    await this.openOrganizationSection("API keys");
    await expect(this.page.getByRole("heading", { name: "API keys", exact: true })).toBeVisible();
    await expect(
      this.page.getByRole("link", { name: "API reference", exact: true }),
    ).toHaveAttribute("href", "https://paseo.sh/docs/hub/api");
    await expect(this.page.getByText("No API keys", { exact: true })).toBeVisible();
    await expectAccessible(this.page);

    await this.page.getByRole("button", { name: "Create API key" }).click();
    const dialog = this.page.getByRole("dialog");
    const form = dialog.getByRole("form", { name: "Create API key" });
    await form.getByLabel("Name").fill("Production deployer");
    await form.getByLabel("Install configuration").check();
    await form.getByLabel("Start runs").check();
    await form.getByRole("button", { name: "Create API key" }).click();

    await expect(dialog.getByRole("heading", { name: "Copy your API key" })).toBeVisible();
    await expectAccessible(this.page);
    const secret = dialog.getByLabel("Generated API key");
    const revealedSecret = await secret.inputValue();
    expect(revealedSecret).toMatch(/^paseo_pk_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/u);
    await expect(
      this.page.evaluate(async (key) => {
        const response = await fetch(`${window.location.origin}/api/daemons/enrollment-tokens`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        return response.status;
      }, revealedSecret),
    ).resolves.toBe(403);
    await this.context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: this.origin,
    });
    await dialog.getByRole("button", { name: "Copy API key" }).click();
    await expect(dialog.getByRole("status")).toHaveText("API key copied.");
    await expect(this.page.evaluate(() => navigator.clipboard.readText())).resolves.toMatch(
      /^paseo_pk_/u,
    );
    await dialog.getByRole("button", { name: "Done" }).click();

    const row = this.page
      .getByRole("table", { name: "API keys" })
      .getByRole("row")
      .filter({ hasText: "Production deployer" });
    await expect(row).toContainText("Install configuration, Start runs");
    await expect(row).toContainText("Active");
    await row.getByRole("button", { name: "Actions for Production deployer" }).click();
    await this.page.getByRole("menuitem", { name: "Revoke" }).click();
    const confirmation = this.page.getByRole("alertdialog");
    await expect(
      confirmation.getByRole("heading", { name: "Revoke Production deployer?" }),
    ).toBeVisible();
    await confirmation.getByRole("button", { name: "Revoke key" }).click();
    await expect(row).toContainText("Revoked");
    await expect(row.getByRole("button", { name: "Actions for Production deployer" })).toHaveCount(
      0,
    );
    await expect(
      this.page.evaluate(async (key) => {
        const response = await fetch(`${window.location.origin}/api/daemons/enrollment-tokens`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        return response.status;
      }, revealedSecret),
    ).resolves.toBe(401);
  }

  async createRunApiKey(): Promise<string> {
    await this.openOrganizationSection("API keys");
    await expect(this.page.getByRole("heading", { name: "API keys", exact: true })).toBeVisible();
    await this.page.getByRole("button", { name: "Create API key" }).click();
    const dialog = this.page.getByRole("dialog");
    const form = dialog.getByRole("form", { name: "Create API key" });
    await form.getByLabel("Name").fill("Phase Two runner");
    await form.getByLabel("Start runs").check();
    await form.getByRole("button", { name: "Create API key" }).click();
    await expect(dialog.getByRole("heading", { name: "Copy your API key" })).toBeVisible();
    const secret = await dialog.getByLabel("Generated API key").inputValue();
    await dialog.getByRole("button", { name: "Done" }).click();
    return secret;
  }

  async signUpForInvitation(account: Account): Promise<void> {
    this.email = account.email.toLowerCase();
    await this.submitInvitationSignUp(account);
    await expect(this.page.getByRole("button", { name: "Accept invitation" })).toBeVisible();
  }

  private async submitSignUp(account: Account): Promise<void> {
    await this.page.getByRole("button", { name: "Create an account" }).click();
    await this.fillSignUpForm(account);
  }

  private async submitInvitationSignUp(account: Account): Promise<void> {
    const form = this.page.getByRole("form", { name: "Create account" });
    await form.getByLabel("Name").fill(account.name);
    await form.getByLabel("Password").fill(account.password);
    await form.getByRole("button", { name: "Create account" }).click();
  }

  private async fillSignUpForm(account: Account): Promise<void> {
    const form = this.page.getByRole("form", { name: "Create account" });
    await form.getByLabel("Name").fill(account.name);
    await form.getByLabel("Email").fill(account.email);
    await form.getByLabel("Password").fill(account.password);
    await form.getByRole("button", { name: "Create account" }).click();
  }

  async proveAuthenticationPendingLocksMode(account: Account): Promise<void> {
    const serverFunctions = "**/_serverFn/**";
    let authRequests = 0;
    let responseCompleted = () => {};
    const completed = new Promise<void>((resolve) => {
      responseCompleted = resolve;
    });
    let releaseResponse = () => {};
    const released = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let responseDelivered = () => {};
    const delivered = new Promise<void>((resolve) => {
      responseDelivered = resolve;
    });
    await this.page.route(serverFunctions, async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.postData()?.includes(account.email)) {
        await route.continue();
        return;
      }
      authRequests += 1;
      const response = await route.fetch();
      responseCompleted();
      await released;
      await route.fulfill({ response });
      responseDelivered();
    });

    const form = this.page.getByRole("form", { name: "Sign in" });
    const toggle = this.page.getByRole("button", { name: "Create an account" });
    try {
      await form.getByLabel("Email").fill(account.email);
      await form.getByLabel("Password").fill(account.password);
      await form.getByRole("button", { name: "Sign in" }).click();
      await completed;

      await expect(toggle).toBeDisabled();
      await expect(form.getByLabel("Email")).toBeDisabled();
      await expect(form.getByLabel("Password")).toBeDisabled();
      await expect(form.getByRole("button", { name: "Sign in" })).toBeDisabled();
      await toggle.click({ force: true });
      await form.getByRole("button", { name: "Sign in" }).click({ force: true });
      await expect(this.page.getByRole("form", { name: "Create account" })).toHaveCount(0);
      expect(authRequests).toBe(1);
    } finally {
      releaseResponse();
      await delivered;
      await this.page.unroute(serverFunctions);
    }
    await expect(this.page.getByRole("heading", { name: "Choose an organization" })).toBeVisible();
  }

  async proveAuthenticationSettlementLocksMode(
    account: Account,
    organization: string,
  ): Promise<void> {
    let authRequests = 0;
    const pending = await this.holdAccountRefetchAfterSuccessfulAuth(account);
    const form = this.page.getByRole("form", { name: "Sign in" });
    const toggle = this.page.getByRole("button", { name: "Create an account" });
    try {
      await form.getByLabel("Email").fill(account.email);
      await form.getByLabel("Password").fill(account.password);
      const observeAuth = (request: Request) => {
        if (
          request.method() === "POST" &&
          request.url().includes("/_serverFn/") &&
          request.postData()?.includes(account.email)
        ) {
          authRequests += 1;
        }
      };
      this.page.on("request", observeAuth);
      try {
        await form.getByRole("button", { name: "Sign in" }).click();
        await pending.accountRefetchStarted();

        await expect(toggle).toBeDisabled();
        await expect(form.getByLabel("Email")).toBeDisabled();
        await expect(form.getByLabel("Password")).toBeDisabled();
        await expect(form.getByRole("button", { name: "Sign in" })).toBeDisabled();
        await toggle.click({ force: true });
        await form.getByRole("button", { name: "Sign in" }).click({ force: true });
        await expect(this.page.getByRole("form", { name: "Create account" })).toHaveCount(0);
        expect(authRequests).toBe(1);
      } finally {
        this.page.off("request", observeAuth);
      }
    } finally {
      await pending.release();
    }
    await expect(
      this.page
        .getByRole("heading", { name: "Choose an organization" })
        .or(this.page.locator("header").first().getByText(organization, { exact: true })),
    ).toBeVisible();
  }

  private async holdAccountRefetchAfterSuccessfulAuth(account: Account): Promise<{
    accountRefetchStarted(): Promise<void>;
    release(): Promise<void>;
  }> {
    const serverFunctions = "**/_serverFn/**";
    let authCompleted = false;
    let refetchReceived = () => {};
    const refetchStarted = new Promise<void>((resolve) => {
      refetchReceived = resolve;
    });
    let releaseRefetch = () => {};
    const released = new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });
    let refetchDelivered = () => {};
    const delivered = new Promise<void>((resolve) => {
      refetchDelivered = resolve;
    });
    let refetchIntercepted = false;
    await this.page.route(serverFunctions, async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.postData()?.includes(account.email)) {
        const response = await route.fetch();
        authCompleted = true;
        await route.fulfill({ response });
        return;
      }
      if (
        authCompleted &&
        request.method() === "GET" &&
        new URL(request.url()).searchParams.has("payload")
      ) {
        refetchIntercepted = true;
        refetchReceived();
        try {
          await released;
          await route.continue();
        } finally {
          refetchDelivered();
        }
        return;
      }
      await route.continue();
    });

    return {
      accountRefetchStarted: () => refetchStarted,
      release: async () => {
        releaseRefetch();
        if (refetchIntercepted) await delivered;
        await this.page.unroute(serverFunctions);
      },
    };
  }

  async createOrganization(name: string): Promise<void> {
    await this.submitOrganization(name);
    await this.expectActiveOrganization(name);
  }

  async rejectOrganizationGateCommand(name: string): Promise<void> {
    const serverFunctions = "**/_serverFn/**";
    let commandReceived = () => {};
    const received = new Promise<void>((resolve) => {
      commandReceived = resolve;
    });
    let releaseCommand = () => {};
    const released = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    await this.page.route(serverFunctions, async (route) => {
      if (route.request().postData()?.includes(name)) {
        commandReceived();
        await released;
        await route.abort();
        return;
      }
      await route.continue();
    });
    try {
      const submission = this.submitOrganization(name);
      await received;
      await expect(this.page.getByRole("button", { name: "Sign out" })).toBeDisabled();
      releaseCommand();
      await submission;
      await expect(
        this.page.getByRole("heading", { name: "Choose an organization" }),
      ).toBeVisible();
      await expect(this.page.getByRole("alert")).toHaveText(
        "We couldn't update your account. Try again.",
      );
    } finally {
      releaseCommand();
      await this.page.unroute(serverFunctions);
    }
  }

  async createAnotherOrganization(name: string): Promise<void> {
    const switcher = this.page.getByRole("button", { name: "Organization" });
    await switcher.click();
    await this.page.getByRole("menuitem", { name: "New organization" }).click();
    const form = this.page.getByRole("form", { name: "Create organization" });
    await expect(form).toBeVisible();
    await form.getByLabel("Organization name").fill(name);
    await form.getByRole("button", { name: "Create organization" }).click();
    await expect(switcher).toContainText(name);
    await expect(
      this.page.locator("header").first().getByText(name, { exact: true }),
    ).toBeVisible();
    await this.expectActiveOrganization(name);
  }

  async createAnotherOrganizationWithoutDisclosure(
    name: string,
    sensitiveText: string,
  ): Promise<void> {
    await this.createAnotherOrganization(name);
    await expect(this.page.getByText(sensitiveText, { exact: true })).toHaveCount(0);
    await this.expectCurrentDaemonAbsent(sensitiveText);
  }

  async replaceDaemonAccountWithoutDisclosure(
    account: Account,
    organizationName: string,
    sensitiveText: string,
  ): Promise<void> {
    await this.signOut();
    await this.signUp(account);
    await this.submitOrganization(organizationName);
    await this.expectActiveOrganization(organizationName);
    await expect(this.page.getByText(sensitiveText, { exact: true })).toHaveCount(0);
    await this.expectCurrentDaemonAbsent(sensitiveText);
  }

  async replaceApprovalAccountWithoutDisclosure(
    account: Account,
    organizationName: string,
    previousOrganizationName: string,
  ): Promise<void> {
    const verificationUrl = this.page.url();
    await this.signOut();
    await this.signUp(account);
    await this.submitOrganization(organizationName);
    await this.expectActiveOrganization(organizationName);
    await expect(this.page.getByText(previousOrganizationName, { exact: true })).toHaveCount(0);
    await this.page.goto(verificationUrl);
    const approval = this.page.getByRole("region", { name: "Approve daemon" });
    await expect(approval.getByText(organizationName, { exact: true })).toBeVisible();
    await expect(approval.getByText(previousOrganizationName, { exact: true })).toHaveCount(0);
  }

  async chooseOrganization(name: string): Promise<void> {
    const switcher = this.page.getByRole("button", { name: "Organization" });
    await switcher.click();
    const menu = this.page.getByRole("menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name, exact: true }).click();
    await expect(menu).toBeHidden();
    await expect(switcher).toContainText(name);
  }

  async returnToProjects(): Promise<void> {
    await this.page.goto(this.origin);
    await expect(this.page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  }

  async rejectOrganizationSwitchAndInvitation(
    destinationOrganization: string,
    invitationEmail: string,
  ): Promise<void> {
    const serverFunctions = "**/_serverFn/**";
    const switcher = this.page.getByRole("button", { name: "Organization" });
    await this.page.route(serverFunctions, async (route) => {
      if (route.request().postData()?.includes('"organizationId"')) {
        await route.abort();
        return;
      }
      await route.continue();
    });
    try {
      await switcher.click();
      await this.page
        .getByRole("menu")
        .getByRole("menuitem", { name: destinationOrganization, exact: true })
        .click();
      await expect(this.page.getByRole("alert")).toHaveText(
        "We couldn't update your account. Try again.",
      );
      await expect(switcher).toContainText("Acme");
    } finally {
      await this.page.unroute(serverFunctions);
    }

    await this.openOrganizationSection("Team");
    await this.page.route(serverFunctions, async (route) => {
      if (route.request().postData()?.includes(invitationEmail)) {
        await route.abort();
        return;
      }
      await route.continue();
    });
    try {
      const form = await this.openInvitationForm();
      await form.getByLabel("Invitee email").fill(invitationEmail);
      await form.getByRole("button", { name: "Create invitation" }).click();
      await expect(this.page.getByRole("alert")).toHaveText(
        "We couldn't update your account. Try again.",
      );
      await expect(this.invitationRow(invitationEmail)).toHaveCount(0);
      await expect(switcher).toContainText("Acme");
    } finally {
      await this.page.unroute(serverFunctions);
    }
  }

  async proveInvitationLocksOrganizationSwitch(
    destinationOrganization: string,
    invitationEmail: string,
  ): Promise<void> {
    const serverFunctions = "**/_serverFn/**";
    let invitationReceived = () => {};
    const received = new Promise<void>((resolve) => {
      invitationReceived = resolve;
    });
    let releaseInvitation = () => {};
    const released = new Promise<void>((resolve) => {
      releaseInvitation = resolve;
    });
    let invitationDelivered = () => {};
    const delivered = new Promise<void>((resolve) => {
      invitationDelivered = resolve;
    });
    await this.page.route(serverFunctions, async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.postData()?.includes(invitationEmail)) {
        await route.continue();
        return;
      }
      invitationReceived();
      try {
        await released;
        await route.continue();
      } finally {
        invitationDelivered();
      }
    });

    const switcher = this.page.getByRole("button", { name: "Organization" });
    try {
      await this.openOrganizationSection("Team");
      const form = await this.openInvitationForm();
      await form.getByLabel("Invitee email").fill(invitationEmail);
      await form.getByRole("button", { name: "Create invitation" }).click();
      await received;

      await expect(this.page.getByRole("heading", { name: "Team" })).toBeVisible();
      await expect(this.page.getByRole("region", { name: "Loading account context" })).toHaveCount(
        0,
      );
      await expect(this.page.getByRole("button", { name: "Invite member" })).toBeDisabled();
      await switcher.click();
      const menu = this.page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(
        menu.getByRole("menuitem", { name: destinationOrganization, exact: true }),
      ).toBeDisabled();
      await expect(menu.getByRole("menuitem", { name: "Acme", exact: true })).toBeDisabled();
      await this.page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    } finally {
      releaseInvitation();
      await delivered;
      await this.page.unroute(serverFunctions);
    }

    await expect(this.invitationRow(invitationEmail)).toBeVisible();
    await this.chooseOrganization(destinationOrganization);
    await expect(this.invitationRow(invitationEmail)).toHaveCount(0);
  }

  async expectOrganizationSwitchUnmountsOldPanel(
    destinationOrganization: string,
    oldDaemonName: string,
  ): Promise<void> {
    let selected = false;
    let refetchReceived = () => {};
    const refetchStarted = new Promise<void>((resolve) => {
      refetchReceived = resolve;
    });
    let releaseRefetch = () => {};
    const released = new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });
    const serverFunctions = "**/_serverFn/**";
    await this.page.route(serverFunctions, async (route) => {
      const request = route.request();
      if (
        selected &&
        request.method() === "GET" &&
        new URL(request.url()).searchParams.has("payload")
      ) {
        refetchReceived();
        await released;
        await route.continue();
        return;
      }
      await route.continue();
    });

    const switcher = this.page.getByRole("button", { name: "Organization" });
    try {
      await switcher.click();
      selected = true;
      await this.page
        .getByRole("menu")
        .getByRole("menuitem", { name: destinationOrganization, exact: true })
        .click();
      await refetchStarted;
      await expect(
        this.page.getByRole("region", { name: "Loading account context" }),
      ).toBeVisible();
      await expect(this.page.getByText(oldDaemonName, { exact: true })).toHaveCount(0);
      await expect(
        this.page.getByRole("button", { name: `Actions for ${oldDaemonName}` }),
      ).toHaveCount(0);
    } finally {
      releaseRefetch();
    }
    await expect(switcher).toContainText(destinationOrganization);
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/projects$/u);
    await expect(this.page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expect(this.page.getByText(oldDaemonName, { exact: true })).toHaveCount(0);
    await this.page.unroute(serverFunctions);
  }

  async openDaemonApproval(
    verificationUrl: string,
    displayName: string | undefined,
    organizationName: string,
  ): Promise<void> {
    await this.page.goto(verificationUrl);
    await expect(this.page.getByRole("heading", { name: "Approve daemon" })).toBeVisible();
    const form = this.page.getByRole("form", { name: "Approve daemon" });
    await expect(form.getByLabel("Daemon slug")).toHaveValue(
      displayName === undefined ? /.+/u : slugify(displayName, "daemon"),
    );
    await expect(
      this.page
        .getByRole("region", { name: "Approve daemon" })
        .getByText(organizationName, { exact: true }),
    ).toBeVisible();
  }

  async approveDaemon(displayName: string): Promise<void> {
    const form = this.page.getByRole("form", { name: "Approve daemon" });
    const name = form.getByLabel("Daemon slug");
    await name.fill(displayName);
    await name.focus();
    await this.page.keyboard.press("Tab");
    await expect(form.getByRole("button", { name: "Deny" })).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(form.getByRole("button", { name: "Approve daemon" })).toBeFocused();
    await this.page.keyboard.press("Enter");
    await expect(this.page.getByRole("heading", { name: "Registration approved" })).toBeVisible();
  }

  async denyDaemon(): Promise<void> {
    await this.page
      .getByRole("form", { name: "Approve daemon" })
      .getByRole("button", { name: "Deny" })
      .click();
    await expect(this.page.getByRole("heading", { name: "Registration denied" })).toBeVisible();
  }

  async returnToDaemonsWithoutDocumentNavigation(): Promise<void> {
    const documentRequests: string[] = [];
    const observeDocumentNavigation = (request: Request) => {
      if (request.isNavigationRequest() && request.frame() === this.page.mainFrame()) {
        documentRequests.push(request.url());
      }
    };
    this.page.on("request", observeDocumentNavigation);
    try {
      await this.page.getByRole("link", { name: "Go to daemons" }).click();
      await expect(this.page).toHaveURL(/\/o\/[^/]+\/daemons$/u);
      await expect(this.page.getByRole("heading", { name: "Daemons" })).toBeVisible();
      expect(documentRequests).toEqual([]);
    } finally {
      this.page.off("request", observeDocumentNavigation);
    }
  }

  async expectRegistrationUnavailable(verificationUrl: string): Promise<void> {
    await this.page.goto(verificationUrl);
    await expect(this.page.getByRole("alert")).toHaveText(
      /This daemon registration request is unavailable/u,
    );
  }

  async expectDaemon(
    displayName: string,
    daemonId: string,
    state: "Connected" | "Offline" | "Revoked",
  ): Promise<void> {
    await this.refreshOrganizationSection("Daemons");
    const daemon = this.daemonRow(displayName);
    await expect(daemon.getByText(displayName, { exact: true })).toBeVisible();
    await expect(daemon.getByText(daemonId.slice(0, 8), { exact: true })).toBeVisible();
    await expect(daemon.getByText(state, { exact: true })).toBeVisible();
    await expect(daemon.getByText(/\w{3} \d{1,2}, \d{4}/u).first()).toBeVisible();
  }

  private daemonRow(displayName: string): Locator {
    return this.page.getByRole("row").filter({ hasText: displayName });
  }

  private async openDaemonRename(displayName: string): Promise<Locator> {
    await this.daemonRow(displayName)
      .getByRole("button", { name: `Actions for ${displayName}` })
      .click();
    await this.page.getByRole("menuitem", { name: "Rename" }).click();
    const form = this.page.getByRole("form", { name: `Rename ${displayName}` });
    await expect(form).toBeVisible();
    return form;
  }

  async renameDaemon(currentName: string, displayName: string): Promise<void> {
    await this.openOrganizationSection("Daemons");
    const form = await this.openDaemonRename(currentName);
    const name = form.getByLabel("Daemon slug");
    await name.fill(displayName);
    await name.focus();
    await this.page.keyboard.press("Tab");
    await expect(form.getByRole("button", { name: "Rename" })).toBeFocused();
    let renamed = false;
    let refetchReceived = () => {};
    const refetchStarted = new Promise<void>((resolve) => {
      refetchReceived = resolve;
    });
    let releaseRefetch = () => {};
    const released = new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });
    const serverFunctions = "**/_serverFn/**";
    await this.page.route(serverFunctions, async (route) => {
      const request = route.request();
      if (request.postData()?.includes(displayName)) {
        const response = await route.fetch();
        renamed = true;
        await route.fulfill({ response });
        return;
      }
      if (renamed && request.method() === "GET") {
        refetchReceived();
        await released;
        await route.continue();
        return;
      }
      await route.continue();
    });
    try {
      await this.page.keyboard.press("Enter");
      await refetchStarted;
      await expect(form).toBeVisible();
    } finally {
      releaseRefetch();
    }
    await expect(form).toBeHidden();
    await this.page.keyboard.press("Escape");
    await expect(this.daemonRow(displayName).getByText(displayName, { exact: true })).toBeVisible();
    await this.page.unroute(serverFunctions);
  }

  async expectDaemonRenameConflict(currentName: string, reservedSlug: string): Promise<void> {
    await this.openOrganizationSection("Daemons");
    const form = await this.openDaemonRename(currentName);
    await form.getByLabel("Daemon slug").fill(reservedSlug);
    await form.getByRole("button", { name: "Rename" }).click();
    await expect(form.getByRole("alert")).toHaveText(
      `The daemon slug “${reservedSlug}” is already in use. Choose another slug.`,
    );
    await expect(form).toBeVisible();
  }

  async expectRenameDaemonLocksAccountContext(
    currentName: string,
    displayName: string,
    destinationOrganization: string,
  ): Promise<void> {
    await this.openOrganizationSection("Daemons");
    const form = await this.openDaemonRename(currentName);
    await form.getByLabel("Daemon slug").fill(displayName);
    const pending = await this.holdDaemonCommand(
      (request) => request.postData()?.includes(displayName) === true,
    );
    try {
      await form.getByRole("button", { name: "Rename" }).click();
      await pending.commandReceived();
      await expect(form).toBeVisible();
      await expect(form.getByLabel("Daemon slug")).toBeDisabled();
      await this.page.getByRole("button", { name: "Close" }).click();
      await expect(form).toBeHidden();
      await this.page.keyboard.press("Escape");
      await expect(
        this.daemonRow(currentName).getByText(currentName, { exact: true }),
      ).toBeVisible();
      await this.expectTenantControlsLocked(destinationOrganization);
    } finally {
      await pending.release();
    }
    await expect(form).toBeHidden();
    await expect(this.daemonRow(displayName).getByText(displayName, { exact: true })).toBeVisible();
    await this.chooseOrganization(destinationOrganization);
    await expect(this.page.getByText(displayName, { exact: true })).toHaveCount(0);
    await this.chooseOrganization("Acme");
  }

  async attemptStaleRename(currentName: string, displayName: string): Promise<void> {
    const form = await this.openDaemonRename(currentName);
    await form.getByLabel("Daemon slug").fill(displayName);
    await form.getByRole("button", { name: "Rename" }).click();
    await expect(this.page.getByRole("heading", { name: "Sign in to Paseo Hub" })).toBeVisible();
    await expect(this.page.getByText(currentName, { exact: true })).toHaveCount(0);
    await expect(this.page.getByText(displayName, { exact: true })).toHaveCount(0);
  }

  async revokeDaemon(displayName: string): Promise<void> {
    const trigger = this.daemonRow(displayName).getByRole("button", {
      name: `Actions for ${displayName}`,
    });
    await trigger.click();
    await this.page.getByRole("menuitem", { name: "Revoke" }).click();
    let dialog = this.page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: `Revoke ${displayName}?` })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await trigger.click();
    await this.page.getByRole("menuitem", { name: "Revoke" }).click();
    dialog = this.page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Revoke daemon" }).click();
    await expect(this.daemonRow(displayName).getByText("Revoked", { exact: true })).toBeVisible();
  }

  async expectRevokeDaemonLocksAccountContext(
    displayName: string,
    daemonId: string,
    destinationOrganization: string,
  ): Promise<void> {
    await this.openOrganizationSection("Daemons");
    const trigger = this.daemonRow(displayName).getByRole("button", {
      name: `Actions for ${displayName}`,
    });
    await trigger.click();
    await this.page.getByRole("menuitem", { name: "Revoke" }).click();
    const dialog = this.page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: `Revoke ${displayName}?` })).toBeVisible();
    const pending = await this.holdDaemonCommand(
      (request) => request.postData()?.includes(daemonId) === true,
    );
    try {
      await dialog.getByRole("button", { name: "Revoke daemon" }).click();
      await pending.commandReceived();
      await expect(
        this.daemonRow(displayName).getByText(displayName, { exact: true }),
      ).toBeVisible();
      await expect(dialog).toBeHidden();
      await this.expectTenantControlsLocked(destinationOrganization);
    } finally {
      await pending.release();
    }
    await expect(this.daemonRow(displayName).getByText("Revoked", { exact: true })).toBeVisible();
    await this.chooseOrganization(destinationOrganization);
    await expect(this.page.getByText(displayName, { exact: true })).toHaveCount(0);
    await this.chooseOrganization("Acme");
  }

  async expectDaemonAbsent(displayName: string): Promise<void> {
    await this.expectCurrentDaemonAbsent(displayName);
  }

  async expectDaemonReadOnly(displayName: string): Promise<void> {
    await this.openOrganizationSection("Daemons");
    const daemon = this.page.getByRole("row").filter({ hasText: displayName });
    await expect(daemon.getByText(displayName, { exact: true })).toBeVisible();
    await expect(daemon.getByRole("button", { name: `Actions for ${displayName}` })).toHaveCount(0);
  }

  async expectRegistrationDecisionLocksAccountContext(
    displayName: string,
    decision: "approved" | "denied",
    destinationOrganization: string,
  ): Promise<void> {
    const form = this.page.getByRole("form", { name: "Approve daemon" });
    await form.getByLabel("Daemon slug").fill(displayName);
    const pending = await this.holdDaemonCommand(
      (request) => request.postData()?.includes(displayName) === true,
    );
    try {
      await form.getByRole("button", { name: "Approve daemon" }).click();
      await pending.commandReceived();
      await expect(this.page.getByRole("heading", { name: "Approve daemon" })).toBeVisible();
      await expect(form.getByLabel("Daemon slug")).toBeDisabled();
      await this.expectTenantControlsLocked(destinationOrganization);
    } finally {
      await pending.release();
    }
    await expect(
      this.page.getByRole("heading", { name: `Registration ${decision}` }),
    ).toBeVisible();
    await this.page.getByRole("link", { name: "Go to daemons" }).click();
    await expect(this.page.getByText(displayName, { exact: true })).toHaveCount(0);
    await this.chooseOrganization(destinationOrganization);
    await expect(this.page.getByText(displayName, { exact: true })).toHaveCount(0);
    await this.chooseOrganization("Acme");
  }

  private async expectTenantControlsLocked(destinationOrganization: string): Promise<void> {
    const switcher = this.page.getByRole("button", { name: "Organization" });
    await expect(this.page.getByRole("region", { name: "Loading account context" })).toHaveCount(0);
    await switcher.click();
    const organizationMenu = this.page.getByRole("menu");
    await expect(organizationMenu).toBeVisible();
    await expect(
      organizationMenu.getByRole("menuitem", { name: "Acme", exact: true }),
    ).toBeDisabled({ timeout: 1_000 });
    await expect(
      organizationMenu.getByRole("menuitem", { name: destinationOrganization, exact: true }),
    ).toBeDisabled({ timeout: 1_000 });
    await this.page.keyboard.press("Escape");
    await expect(organizationMenu).toBeHidden();

    await this.page.getByRole("button", { name: this.accountEmail }).click();
    const accountMenu = this.page.getByRole("menu");
    await expect(accountMenu).toBeVisible();
    await expect(accountMenu.getByRole("menuitem", { name: "Sign out" })).toBeDisabled({
      timeout: 1_000,
    });
    await this.page.keyboard.press("Escape");
    await expect(accountMenu).toBeHidden();
  }

  private async holdDaemonCommand(matches: (request: Request) => boolean): Promise<{
    commandReceived(): Promise<void>;
    release(): Promise<void>;
  }> {
    const routePattern = "**/_serverFn/**";
    let commandReceived = () => {};
    const received = new Promise<void>((resolve) => {
      commandReceived = resolve;
    });
    let releaseCommand = () => {};
    const released = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    let commandDelivered = () => {};
    const delivered = new Promise<void>((resolve) => {
      commandDelivered = resolve;
    });
    let commandIntercepted = false;
    await this.page.route(routePattern, async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !matches(request)) {
        await route.continue();
        return;
      }
      commandIntercepted = true;
      commandReceived();
      try {
        await released;
        await route.continue();
      } finally {
        commandDelivered();
      }
    });
    return {
      commandReceived: () => received,
      release: async () => {
        releaseCommand();
        if (commandIntercepted) await delivered;
        if (!this.page.isClosed()) await this.page.unroute(routePattern);
      },
    };
  }

  async navigateToDaemonsFromMobileSidebar(): Promise<void> {
    await this.page.goto(this.origin);
    const trigger = this.page.getByRole("button", { name: "Toggle Sidebar" });
    await trigger.focus();
    await this.page.keyboard.press("Enter");
    const sidebar = this.page.getByRole("dialog", { name: "Sidebar" });
    await expect(sidebar).toBeVisible();
    const daemons = sidebar.getByRole("link", { name: "Daemons", exact: true });
    await daemons.focus();
    await this.page.keyboard.press("Enter");
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/daemons$/u);
    await expect(sidebar).toBeHidden();
    await expect(this.page.getByRole("heading", { name: "Daemons", exact: true })).toBeVisible();
    await expect(this.page.getByText("No daemons registered", { exact: true })).toBeVisible();
    const width = await this.page.getByRole("main").evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(width.document).toBeLessThanOrEqual(width.viewport);
  }

  async invite(email: string, role: "admin" | "member"): Promise<string> {
    await this.refreshOrganizationSection("Team");
    const form = await this.openInvitationForm();
    await form.getByLabel("Invitee email").fill(email);
    await this.chooseOption(form.getByRole("combobox", { name: "Role" }), roleLabel(role));
    await form.getByRole("button", { name: "Create invitation" }).click();
    await expect(form).toBeHidden();
    await this.context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: this.origin,
    });
    const actions = this.invitationRow(email).getByRole("button", { name: `Actions for ${email}` });
    await actions.click();
    await this.page.getByRole("menuitem", { name: "Copy link" }).click();
    await expect(this.page.getByRole("status")).toHaveText("Invitation link copied.");
    return z
      .string()
      .url()
      .parse(await this.page.evaluate(() => navigator.clipboard.readText()));
  }

  private async openInvitationForm(): Promise<Locator> {
    await this.page.getByRole("button", { name: "Invite member" }).click();
    const form = this.page.getByRole("form", { name: "Invite team member" });
    await expect(form).toBeVisible();
    return form;
  }

  private invitationRow(email: string): Locator {
    return this.page
      .getByRole("table", { name: "Pending invitations" })
      .getByRole("row")
      .filter({ hasText: email });
  }

  async copyInvitationAndExpectFeedback(email: string, invitationLink: string): Promise<void> {
    await this.context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: this.origin,
    });
    const invitation = this.invitationRow(email);
    await invitation.getByRole("button", { name: `Actions for ${email}` }).click();
    await this.page.getByRole("menuitem", { name: "Copy link" }).click();
    await expect(this.page.getByRole("status")).toHaveText("Invitation link copied.");
    expect(await this.page.evaluate(() => navigator.clipboard.readText())).toBe(invitationLink);
    await expectAccessible(this.page);
  }

  async openInvitation(link: string): Promise<void> {
    await this.page.goto(link);
  }

  async acceptInvitation(): Promise<void> {
    await this.page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(this.page.getByRole("heading", { name: "Projects" })).toBeVisible();
  }

  async acceptInvitationWithSignOutLocked(): Promise<void> {
    const serverFunctions = "**/_serverFn/**";
    let acceptanceReceived = () => {};
    const received = new Promise<void>((resolve) => {
      acceptanceReceived = resolve;
    });
    let releaseAcceptance = () => {};
    const released = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    let acceptanceDelivered = () => {};
    const delivered = new Promise<void>((resolve) => {
      acceptanceDelivered = resolve;
    });
    await this.page.route(serverFunctions, async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.postData()?.includes('"invitationId"')) {
        await route.continue();
        return;
      }
      acceptanceReceived();
      try {
        await released;
        await route.continue();
      } finally {
        acceptanceDelivered();
      }
    });

    const accept = this.page.getByRole("button", { name: "Accept invitation" });
    const signOut = this.page.getByRole("button", { name: "Sign out" });
    try {
      await accept.click();
      await received;
      await expect(accept).toBeDisabled();
      await expect(signOut).toBeDisabled();
    } finally {
      releaseAcceptance();
      await delivered;
      await this.page.unroute(serverFunctions);
    }
    await expect(this.page.getByRole("heading", { name: "Projects" })).toBeVisible();
  }

  async acceptInvitationAfterSessionExpiry(
    account: Account,
    invitation: string,
    organization: string,
  ): Promise<void> {
    const invitationUrl = new URL(invitation);
    await this.page.getByRole("button", { name: "Accept invitation" }).click();
    const signIn = this.page.getByRole("form", { name: "Sign in" });
    await expect(signIn).toBeVisible();
    await expect(this.page).toHaveURL(invitationUrl.toString());
    await expect(signIn.getByLabel("Email")).toHaveValue(account.email);
    await signIn.getByLabel("Password").fill(account.password);
    await signIn.getByRole("button", { name: "Sign in" }).click();
    await expect(this.page).toHaveURL(invitationUrl.toString());
    await expect(this.page.getByRole("button", { name: "Accept invitation" })).toBeVisible();
    await this.acceptInvitation();
    await this.expectActiveOrganization(organization);
  }

  async expectActiveOrganization(name: string): Promise<void> {
    await expect(
      this.page.locator("header").first().getByText(name, { exact: true }),
    ).toBeVisible();
  }

  async expectDesktopSidebarAndOrganizationMenu(): Promise<void> {
    await this.page.goto(this.origin);
    const identity = this.page.getByText(this.accountEmail, { exact: true });
    await expect(identity).toBeVisible();
    const organization = this.page.getByRole("button", { name: "Organization" });
    const projects = this.page.getByRole("link", { name: "Projects", exact: true });
    const daemons = this.page.getByRole("link", { name: "Daemons", exact: true });
    const connections = this.page.getByRole("link", { name: "Connections", exact: true });
    const apiKeys = this.page.getByRole("link", { name: "API keys", exact: true });
    const team = this.page.getByRole("link", { name: "Team", exact: true });
    const account = this.page.getByRole("button", { name: this.accountEmail });

    await this.page.keyboard.press("Tab");
    await expect(organization).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(projects).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(daemons).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(connections).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(apiKeys).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(team).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(account).toBeFocused();

    await expect(organization).toContainText("Owner");
    await organization.focus();
    await this.page.keyboard.press("Enter");
    const menu = this.page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "New organization" })).toBeVisible();
    await this.page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(organization).toBeFocused();

    await this.page.keyboard.press("Control+b");
    await expect(identity).toBeHidden();
    await expectAccessible(this.page);
    await this.page.keyboard.press("Control+b");
    await expect(identity).toBeVisible();
  }

  async createAdminInvitationWithKeyboard(email: string): Promise<void> {
    await this.openOrganizationSection("Team");
    await this.page.reload();
    const organization = this.page.getByRole("button", { name: "Organization" });
    const projects = this.page.getByRole("link", { name: "Projects", exact: true });
    const daemons = this.page.getByRole("link", { name: "Daemons", exact: true });
    const connections = this.page.getByRole("link", { name: "Connections", exact: true });
    const apiKeys = this.page.getByRole("link", { name: "API keys", exact: true });
    const team = this.page.getByRole("link", { name: "Team", exact: true });
    const account = this.page.getByRole("button", { name: this.accountEmail });
    const invite = this.page.getByRole("button", { name: "Invite member" });
    await expect(invite).toBeVisible();

    await this.page.keyboard.press("Tab");
    await expect(organization).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(projects).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(daemons).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(connections).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(apiKeys).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(team).toBeFocused();
    await this.page.keyboard.press("Tab");
    await expect(account).toBeFocused();

    await invite.focus();
    await this.page.keyboard.press("Enter");
    const form = this.page.getByRole("form", { name: "Invite team member" });
    const inviteeEmail = form.getByLabel("Invitee email");
    const role = form.getByRole("combobox", { name: "Role" });
    await expect(form).toBeVisible();
    await expect(inviteeEmail).toBeFocused();
    await this.page.keyboard.type(email);
    await this.page.keyboard.press("Tab");
    await expect(role).toBeFocused();
    await this.page.keyboard.press("Enter");
    const listbox = this.page.getByRole("listbox");
    const member = listbox.getByRole("option", { name: "Member", exact: true });
    const admin = listbox.getByRole("option", { name: "Admin", exact: true });
    await expect(listbox).toBeVisible();
    await expect(member).toBeFocused();
    await this.page.keyboard.press("ArrowUp");
    await expect(admin).toBeFocused();
    await this.page.keyboard.press("Enter");
    await expect(listbox).toBeHidden();
    await expect(role).toBeFocused();
    await expect(role).toHaveText("Admin");
    await this.page.keyboard.press("Tab");
    const createInvitation = form.getByRole("button", { name: "Create invitation" });
    await expect(createInvitation).toBeFocused();
    await this.page.keyboard.press("Enter");
    await expect(form).toBeHidden();
    await expect(this.invitationRow(email).getByText("Admin", { exact: true })).toBeVisible();
  }

  async navigateToTeamFromMobileSidebar(): Promise<void> {
    await this.page.goto(this.origin);
    await expect(this.page.getByRole("heading", { name: "Projects" })).toBeVisible();
    const trigger = this.page.getByRole("button", { name: "Toggle Sidebar" });
    await this.page.keyboard.press("Tab");
    await expect(trigger).toBeFocused();
    await this.page.keyboard.press("Enter");
    const sidebar = this.page.getByRole("dialog", { name: "Sidebar" });
    await expect(sidebar).toBeVisible();
    const organization = sidebar.getByRole("button", { name: "Organization" });
    const team = sidebar.getByRole("link", { name: "Team", exact: true });
    await expect(organization).toBeFocused();
    await expectAccessible(this.page);
    await this.page.keyboard.press("Escape");
    await expect(sidebar).toBeHidden();
    await expect(trigger).toBeFocused();
    await this.page.keyboard.press("Enter");
    await expect(sidebar).toBeVisible();
    await expect(organization).toBeFocused();
    // Forward through the destinations in their rendered order rather than relying on the
    // focus trap wrapping backwards: the drawer now ends on the account menu, not on Team.
    for (const destination of ["Projects", "Daemons", "Connections", "API keys", "Team"]) {
      await this.page.keyboard.press("Tab");
      await expect(sidebar.getByRole("link", { name: destination, exact: true })).toBeFocused();
    }
    await expect(team).toBeFocused();
    await this.page.keyboard.press("Enter");
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/team$/u);
    await expect(sidebar).toBeHidden();
    await expect(this.page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
  }

  async navigateToConnectionsFromMobileSidebar(): Promise<void> {
    await this.page.goto(this.origin);
    const trigger = this.page.getByRole("button", { name: "Toggle Sidebar" });
    await trigger.click();
    const sidebar = this.page.getByRole("dialog", { name: "Sidebar" });
    await sidebar.getByRole("link", { name: "Connections", exact: true }).click();
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/connections$/u);
    await expect(sidebar).toBeHidden();
    await this.expectConnectionContents();
  }

  async expectConnections(): Promise<void> {
    await this.expectConnectionShell();
    await expect(this.page.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
    await expect(this.page.getByRole("button", { name: "Connect Discord" })).toBeVisible();
  }

  async expectMemberConnections(): Promise<void> {
    await this.expectConnectionShell();
    await expect(this.page.getByRole("button", { name: /Connect|Revoke/u })).toHaveCount(0);
  }

  async expectEntitlements(): Promise<void> {
    await this.openOrganizationSection("Entitlements");
    await expect(
      this.page.getByRole("heading", { name: "Entitlements", exact: true, level: 1 }),
    ).toBeVisible();
    const table = this.page.getByRole("table", { name: "Entitlements" });
    await expect(this.entitlementRow(table, "Seats")).toContainText("Unlimited");
    await expect(this.entitlementRow(table, "Members can invite")).toContainText("Allowed");
    await expectAccessible(this.page);
  }

  private entitlementRow(table: Locator, entitlement: string): Locator {
    return table
      .getByRole("row")
      .filter({ has: this.page.getByRole("cell", { name: entitlement, exact: true }) });
  }

  async openSeatOverrideEditor(input: { max: number; reason: string }): Promise<void> {
    await this.openOrganizationSection("Entitlements");
    const table = this.page.getByRole("table", { name: "Entitlements" });
    await this.entitlementRow(table, "Seats")
      .getByRole("button", { name: "Override seat limit" })
      .click();
    const dialog = this.page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Seat limit").fill(String(input.max));
    await dialog.getByLabel("Reason").fill(input.reason);
  }

  async saveSeatOverride(expectedSeats: number): Promise<void> {
    const dialog = this.page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Save override" }).click();
    await expect(dialog).toBeHidden();
    const table = this.page.getByRole("table", { name: "Entitlements" });
    await expect(this.entitlementRow(table, "Seats")).toContainText(String(expectedSeats));
    await expectAccessible(this.page);
  }

  async expectInviteRefusedBySeatLimit(
    email: string,
    expected: { limit: number; current: number },
  ): Promise<void> {
    await this.refreshOrganizationSection("Team");
    const form = await this.openInvitationForm();
    await form.getByLabel("Invitee email").fill(email);
    await form.getByRole("button", { name: "Create invitation" }).click();
    await expect(form).toBeHidden();
    const alert = this.page.getByRole("alert");
    await expect(alert).toContainText("Seat limit reached");
    await expect(alert).toContainText(`${expected.current} of ${expected.limit} seats`);
    await expect(alert).toContainText("Entitlements page");
    await expect(this.invitationRow(email)).toHaveCount(0);
  }

  async expectEntitlementsAudit(expected: { actor: string; reason: string }): Promise<void> {
    await this.openOrganizationSection("Entitlements");
    const auditRow = this.page
      .getByRole("table", { name: "Audit trail" })
      .getByRole("row")
      .filter({ hasText: expected.reason });
    await expect(auditRow).toContainText("Override");
    await expect(auditRow).toContainText(expected.actor);
    await expect(auditRow).toContainText(expected.reason);
    await expectAccessible(this.page);
  }

  private async expectConnectionShell(): Promise<void> {
    await this.openOrganizationSection("Connections");
    await this.expectConnectionContents();
  }

  private async expectConnectionContents(): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: "Connections", exact: true, level: 1 }),
    ).toBeVisible();
    await expect(this.page.getByText("No connections", { exact: true })).toBeVisible();
    await expect(this.page.getByText(/does not deploy a/u)).toHaveCount(0);
    const widths = await this.page.getByRole("main").evaluate((main) => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      main: main.scrollWidth,
      visible: main.clientWidth,
    }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport);
    expect(widths.main).toBeLessThanOrEqual(widths.visible);
    await expectAccessible(this.page);
  }

  async connectGitHub(): Promise<void> {
    await this.openOrganizationSection("Connections");
    const connectionsUrl = this.page.url();
    await this.page.getByRole("button", { name: "Connect GitHub" }).click();
    await expect(this.page).toHaveURL(connectionsUrl);
    await expect(this.page.getByRole("status")).toHaveText("GitHub connected.");
  }

  async connectDiscord(): Promise<void> {
    const connectionsUrl = this.page.url();
    await this.page.getByRole("button", { name: "Connect Discord" }).click();
    await expect(this.page).toHaveURL(connectionsUrl);
    await expect(this.page.getByRole("status")).toHaveText("Discord connected.");
  }

  async beginProviderConnection(provider: "github" | "discord"): Promise<string> {
    await this.openOrganizationSection("Connections");
    const connectionsUrl = this.page.url();
    const callback = `**/api/integrations/${provider}/**`;
    const name = provider === "github" ? "GitHub" : "Discord";
    let destination: string | undefined;
    await this.page.route(callback, (route) => {
      destination = route.request().url();
      void route.abort();
    });
    await this.page.getByRole("button", { name: `Connect ${name}` }).click();
    await expect.poll(() => destination).toBeDefined();
    await this.page.unroute(callback);
    await this.page.goto(connectionsUrl);
    await expect(this.page.getByRole("heading", { name: "Connections", level: 1 })).toBeVisible();
    return z.string().url().parse(destination);
  }

  async expectProviderStartLocksAccountContext(
    provider: "github" | "discord",
    destinationOrganization: string,
  ): Promise<void> {
    const pending = await this.holdProviderStartBeforeServer(provider);
    const name = provider === "github" ? "GitHub" : "Discord";
    const switcher = this.page.getByRole("button", { name: "Organization" });
    try {
      await this.openOrganizationSection("Connections");
      await this.page.getByRole("button", { name: `Connect ${name}` }).click();
      await pending.startReceived();

      await expect(this.page.getByRole("button", { name: `Connect ${name}` })).toBeDisabled();
      await switcher.click();
      const organizationMenu = this.page.getByRole("menu");
      await expect(organizationMenu).toBeVisible();
      await expect(
        organizationMenu.getByRole("menuitem", { name: "Redirect Acme", exact: true }),
      ).toBeDisabled();
      await expect(
        organizationMenu.getByRole("menuitem", { name: destinationOrganization, exact: true }),
      ).toBeDisabled();
      await this.page.keyboard.press("Escape");
      await expect(organizationMenu).toBeHidden();

      await this.page.getByRole("button", { name: this.accountEmail }).click();
      const accountMenu = this.page.getByRole("menu");
      await expect(accountMenu).toBeVisible();
      await expect(accountMenu.getByRole("menuitem", { name: "Sign out" })).toBeDisabled();
      await this.page.keyboard.press("Escape");
      await expect(accountMenu).toBeHidden();
    } finally {
      await pending.release();
    }
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/connections$/u);
    await expect(this.page.getByRole("status")).toHaveText(`${name} connected.`);
    await this.chooseOrganization(destinationOrganization);
    await expect(this.page.getByText(`${name} connected.`)).toHaveCount(0);
  }

  private async holdProviderStartBeforeServer(provider: "github" | "discord"): Promise<{
    startReceived(): Promise<void>;
    release(): Promise<void>;
  }> {
    await this.openOrganizationSection("Connections");
    let startReceived = () => {};
    const received = new Promise<void>((resolve) => {
      startReceived = resolve;
    });
    let releaseStart = () => {};
    const released = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startDelivered = () => {};
    const delivered = new Promise<void>((resolve) => {
      startDelivered = resolve;
    });
    let startIntercepted = false;
    const routePattern = "**/*";
    await this.page.route(routePattern, async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        !request.postData()?.includes('"provider"') ||
        !request.postData()?.includes(`"${provider}"`)
      ) {
        await route.continue();
        return;
      }
      startIntercepted = true;
      startReceived();
      try {
        await released;
        await route.continue();
      } finally {
        startDelivered();
      }
    });
    return {
      startReceived: () => received,
      release: async () => {
        releaseStart();
        if (startIntercepted) await delivered;
        await this.page.unroute(routePattern);
      },
    };
  }

  async expectForgedConnectionStateRejected(): Promise<void> {
    const forged = new URL("/api/integrations/github/setup", this.origin);
    forged.searchParams.set("state", "forged-state");
    forged.searchParams.set("setup_action", "install");
    forged.searchParams.set("installation_id", "42");
    await this.expectUntrustedConnectionReturnUnavailable(forged.toString());
  }

  async expectGitHubConnectionUnavailable(): Promise<void> {
    await this.openOrganizationSection("Connections");
    const connectionsUrl = this.page.url();
    await this.page.getByRole("button", { name: "Connect GitHub" }).click();
    await expect(this.page).toHaveURL(connectionsUrl);
    await expect(this.page.getByRole("status")).toHaveText(
      "The connection could not be completed.",
    );
    await expect(this.page.getByText("No connections", { exact: true })).toBeVisible();
    await this.expectNoProviderIdentity("acme-inc");
  }

  async expectDiscordConnectionUnavailable(): Promise<void> {
    const connectionsUrl = this.page.url();
    await this.page.getByRole("button", { name: "Connect Discord" }).click();
    await expect(this.page).toHaveURL(connectionsUrl);
    await expect(this.page.getByRole("status")).toHaveText(
      "The connection could not be completed.",
    );
    await expect(this.page.getByText("No connections", { exact: true })).toBeVisible();
    await this.expectNoProviderIdentity("Acme Guild");
  }

  async expectConnectionReturnConnected(url: string, status: string): Promise<void> {
    const connectionsUrl = this.page.url();
    await this.page.goto(url);
    await expect(this.page).toHaveURL(connectionsUrl);
    await expect(this.page.getByRole("status")).toHaveText(status);
  }

  async expectConnectionReturnConnectedForOrganization(
    url: string,
    status: string,
    organization: string,
  ): Promise<void> {
    await this.page.goto(url);
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/connections$/u);
    await expect(this.page.getByRole("button", { name: "Organization" })).toContainText(
      organization,
    );
    await expect(this.page.getByRole("status")).toHaveText(status);
  }

  async expectConnectionReturnUnavailable(url: string): Promise<void> {
    await this.expectUntrustedConnectionReturnUnavailable(url);
  }

  async expectUntrustedConnectionReturnUnavailable(url: string): Promise<void> {
    await this.page.goto(url);
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/projects$/u);
    await expect(this.page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expect(this.page.getByRole("status")).toHaveText(
      "The connection could not be completed.",
    );
  }

  async expectNoProviderIdentity(value: string): Promise<void> {
    await this.openOrganizationSection("Connections");
    await expect(this.page.getByText(value)).toHaveCount(0);
  }

  async expectConnectedProviders(expected: {
    github: string;
    installationId: string;
    discord: string;
    guildId: string;
  }): Promise<void> {
    await this.expectProviderDetails(expected);
    await expect(this.page.getByRole("button", { name: /^Actions for /u })).toHaveCount(2);
  }

  async expectMemberConnectedProviders(expected: {
    github: string;
    installationId: string;
    discord: string;
    guildId: string;
  }): Promise<void> {
    await this.expectProviderDetails(expected);
    await expect(this.page.getByRole("button", { name: /^Actions for /u })).toHaveCount(0);
  }

  private async expectProviderDetails(expected: {
    github: string;
    installationId: string;
    discord: string;
    guildId: string;
  }): Promise<void> {
    await this.openOrganizationSection("Connections");
    const connectionsUrl = this.page.url();
    const github = this.connectionRow("GitHub");
    const discord = this.connectionRow("Discord");
    await expect(github.getByRole("cell").first()).toContainText(expected.github);
    await expect(github.getByRole("cell").first()).toContainText(
      `installation ${expected.installationId}`,
    );
    await expect(discord.getByRole("cell").first()).toContainText(expected.discord);
    await expect(discord.getByRole("cell").first()).toContainText(`guild ${expected.guildId}`);
    await expect(this.page).toHaveURL(connectionsUrl);
    await expect(this.page.getByText(/ephemeral|state|code=/u)).toHaveCount(0);
    await expectAccessible(this.page);
  }

  async disconnectProviders(): Promise<void> {
    for (const provider of ["GitHub", "Discord"]) {
      const row = this.connectionRow(provider);
      await row.getByRole("button", { name: /^Actions for /u }).click();
      await this.page.getByRole("menuitem", { name: "Revoke" }).click();
      const dialog = this.page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Revoke connection" }).click();
      await expect(row).toHaveCount(0);
      await expect(this.page.getByRole("status")).toHaveText(`${provider} disconnected.`);
    }
  }

  async proveConnectionDisconnectLocksOrganizationSwitch(
    destinationOrganization: string,
  ): Promise<void> {
    const switcher = this.page.getByRole("button", { name: "Organization" });
    await this.openOrganizationSection("Connections");
    const github = this.connectionRow("GitHub");
    const trigger = github.getByRole("button", { name: /^Actions for /u });
    await expect(trigger).toBeVisible();
    const pending = await this.holdGitHubDisconnectStatusRefresh();
    try {
      await trigger.click();
      await this.page.getByRole("menuitem", { name: "Revoke" }).click();
      const dialog = this.page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Revoke connection" }).click();
      await pending.disconnectFinished();
      await pending.refreshStarted();

      await expect(this.page.getByRole("heading", { name: "Connections", level: 1 })).toBeVisible();
      await expect(this.page.getByRole("region", { name: "Loading account context" })).toHaveCount(
        0,
      );
      await trigger.click();
      await expect(this.page.getByRole("menuitem", { name: "Revoke" })).toBeDisabled();
      await this.page.keyboard.press("Escape");
      await switcher.click();
      const menu = this.page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Acme", exact: true })).toBeDisabled();
      await expect(
        menu.getByRole("menuitem", { name: destinationOrganization, exact: true }),
      ).toBeDisabled();
      await this.page.keyboard.press("Escape");
      await expect(menu).toBeHidden();

      await this.page.getByRole("button", { name: this.accountEmail }).click();
      const accountMenu = this.page.getByRole("menu");
      await expect(accountMenu).toBeVisible();
      await expect(accountMenu.getByRole("menuitem", { name: "Sign out" })).toBeDisabled();
      await this.page.keyboard.press("Escape");
      await expect(accountMenu).toBeHidden();
    } finally {
      await pending.release();
    }

    await expect(this.page.getByRole("status")).toHaveText("GitHub disconnected.");
    await expect(github).toHaveCount(0);
    await this.chooseOrganization(destinationOrganization);
    await this.openOrganizationSection("Connections");
    await expect(this.connectionRow("GitHub")).toBeVisible();
  }

  private async holdGitHubDisconnectStatusRefresh(): Promise<{
    disconnectFinished(): Promise<void>;
    refreshStarted(): Promise<void>;
    release(): Promise<void>;
  }> {
    const serverFunctions = "**/*";
    const disconnectFinished = this.page.waitForResponse((response) => {
      const request = response.request();
      return request.method() === "POST" && request.url().includes("/_serverFn");
    });
    let refreshReceived = () => {};
    const received = new Promise<void>((resolve) => {
      refreshReceived = resolve;
    });
    let releaseRefresh = () => {};
    const released = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshDelivered = () => {};
    const delivered = new Promise<void>((resolve) => {
      refreshDelivered = resolve;
    });
    let refreshIntercepted = false;
    await this.page.route(serverFunctions, async (route) => {
      const request = route.request();
      if (request.method() === "GET" && request.url().includes("/_serverFn")) {
        refreshIntercepted = true;
        refreshReceived();
        try {
          await released;
          await route.continue();
        } finally {
          refreshDelivered();
        }
        return;
      }
      await route.continue();
    });

    return {
      disconnectFinished: () => disconnectFinished.then(() => undefined),
      refreshStarted: () => received,
      release: async () => {
        releaseRefresh();
        if (refreshIntercepted) await delivered;
        await this.page.unroute(serverFunctions);
      },
    };
  }

  async expectMemberConnectionMutationDenied(): Promise<void> {
    await this.openOrganizationSection("Connections");
    await expect(this.page.getByRole("button", { name: /Connect|Revoke/u })).toHaveCount(0);
  }

  async expectNotConfiguredConnections(): Promise<void> {
    await this.openOrganizationSection("Connections");
    await expect(this.page.getByText("Not configured", { exact: true })).toHaveCount(3);
    await expect(this.page.getByRole("button", { name: /Connect|Revoke/u })).toHaveCount(0);
    await expectAccessible(this.page);
  }

  async expectGitHubApprovalRequired(): Promise<void> {
    await this.openOrganizationSection("Connections");
    await this.requestGitHubApproval();
    await this.requestGitHubApproval();
    await expect(this.page.getByText("No connections", { exact: true })).toBeVisible();
  }

  private async requestGitHubApproval(): Promise<void> {
    const connectionsUrl = this.page.url();
    const returned = this.page.waitForResponse((response) =>
      response.url().includes("/api/integrations/github/setup?"),
    );
    await this.page.getByRole("button", { name: "Connect GitHub" }).click();
    await returned;
    await expect(this.page).toHaveURL(connectionsUrl);
    await expect(this.page.getByRole("status")).toHaveText(
      "GitHub owner approval is required. Retry after approval.",
    );
  }

  async expectSuspendedGitHubConnection(): Promise<void> {
    await this.openOrganizationSection("Connections");
    const github = this.connectionRow("GitHub");
    await expect(github.getByText("Suspended", { exact: true })).toBeVisible();
    await expect(this.page.getByRole("button", { name: "Reconnect GitHub" })).toBeVisible();
    await github.getByRole("button", { name: /^Actions for /u }).click();
    await this.page.getByRole("menuitem", { name: "Revoke" }).click();
    const dialog = this.page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Revoke connection" }).click();
    await expect(github).toHaveCount(0);
    await expectAccessible(this.page);
  }

  async expectMobileTeamFitsViewport(): Promise<void> {
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/team$/u);
    await expect(this.page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
    await expect(this.page.getByText("No pending invitations", { exact: true })).toBeVisible();
    const table = this.page.getByRole("table", { name: "Members" });
    const widths = await table.evaluate((element) => {
      const container = element.parentElement;
      if (container === null) throw new Error("members table container is missing");
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        containerWidth: container.clientWidth,
        containerScrollWidth: container.scrollWidth,
      };
    });
    expect(widths.documentWidth).toBeLessThanOrEqual(widths.viewportWidth);
    expect(widths.containerScrollWidth).toBeLessThanOrEqual(widths.containerWidth);
    await expectAccessible(this.page);
  }

  async expectTeamDestructiveConfirmations(
    memberName: string,
    invitationEmail: string,
  ): Promise<void> {
    await this.openOrganizationSection("Team");
    await this.expectMemberRemovalConfirmation(memberName);
    await this.expectInvitationCancellationConfirmation(invitationEmail);
  }

  private async expectMemberRemovalConfirmation(memberName: string): Promise<void> {
    const member = this.page.getByRole("row").filter({ hasText: memberName });
    const actions = member.getByRole("button", { name: `Actions for ${memberName}` });
    await actions.click();
    await this.page.getByRole("menuitem", { name: `Remove ${memberName}` }).click();
    const memberDialog = this.page.getByRole("alertdialog", {
      name: `Remove ${memberName}?`,
    });
    await expect(memberDialog).toBeVisible();
    await this.page.keyboard.press("Escape");
    await expect(memberDialog).toBeHidden();
    await expect(member).toBeVisible();
    await actions.click();
    await this.page.getByRole("menuitem", { name: `Remove ${memberName}` }).click();
    await memberDialog.getByRole("button", { name: `Remove ${memberName}` }).click();
    await expect(member).toHaveCount(0);
  }

  private async expectInvitationCancellationConfirmation(invitationEmail: string): Promise<void> {
    const invitation = this.invitationRow(invitationEmail);
    const actions = invitation.getByRole("button", { name: `Actions for ${invitationEmail}` });
    await actions.click();
    await this.page.getByRole("menuitem", { name: "Cancel invitation" }).click();
    const invitationDialog = this.page.getByRole("alertdialog", {
      name: `Cancel invitation for ${invitationEmail}?`,
    });
    await invitationDialog.getByRole("button", { name: "Keep invitation" }).click();
    await expect(invitationDialog).toBeHidden();
    await expect(invitation).toBeVisible();
    await actions.click();
    await this.page.getByRole("menuitem", { name: "Cancel invitation" }).click();
    await invitationDialog.getByRole("button", { name: "Cancel invitation" }).click();
    await expect(invitation).toHaveCount(0);
    await expect(this.page.getByText("No pending invitations", { exact: true })).toBeVisible();
  }

  async expectMemberBoundary(organizationName: string): Promise<void> {
    await this.openOrganizationSection("Team");
    await expect(
      this.page.locator("header").first().getByText(organizationName, { exact: true }),
    ).toBeVisible();
    await expect(this.page.getByRole("button", { name: "Invite member" })).toHaveCount(0);
    await expect(this.page.getByRole("heading", { name: "Pending invitations" })).toHaveCount(0);
  }

  async changeMemberRole(memberName: string, role: "owner" | "admin" | "member"): Promise<void> {
    await this.refreshOrganizationSection("Team");
    const member = this.page.getByRole("row").filter({ hasText: memberName });
    await this.chooseOption(
      member.getByRole("combobox", { name: `Role for ${memberName}` }),
      roleLabel(role),
    );
    await expect(member.getByRole("combobox", { name: `Role for ${memberName}` })).toHaveText(
      roleLabel(role),
    );
  }

  async expectTeam(expected: TeamExpectation): Promise<void> {
    await this.refreshOrganizationSection("Team");
    const members = this.page.getByRole("table", { name: "Members" });
    for (const value of expected.membersPresent)
      await expect(members.getByText(value, { exact: true })).toBeVisible();
    for (const value of expected.membersAbsent)
      await expect(members.getByText(value, { exact: true })).toHaveCount(0);
    const invitations = this.page.getByRole("table", { name: "Pending invitations" });
    if (expected.invitationsPresent === undefined && expected.invitationsAbsent === undefined) {
      await expect(invitations).toHaveCount(0);
    }
    for (const email of expected.invitationsPresent ?? [])
      await expect(invitations.getByText(email, { exact: true })).toBeVisible();
    for (const email of expected.invitationsAbsent ?? [])
      await expect(this.page.getByText(email, { exact: true })).toHaveCount(0);
  }

  get accountEmail(): string {
    if (this.email === undefined) throw new Error("browser account has not signed up");
    return this.email;
  }

  async attemptInvitation(email: string): Promise<void> {
    const form = await this.openInvitationForm();
    await form.getByLabel("Invitee email").fill(email);
    await form.getByRole("button", { name: "Create invitation" }).click();
  }

  async expectCachedTeamCleared(
    destination: "signedOut" | "organizationRequired",
    cachedValues: string[],
  ): Promise<void> {
    if (destination === "signedOut") {
      await expect(this.page.getByRole("form", { name: "Sign in" })).toBeVisible();
    } else {
      await expect(
        this.page.getByRole("heading", { name: "Choose an organization" }),
      ).toBeVisible();
    }
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/team$/u);
    await expect(this.page.getByRole("heading", { name: "Team" })).toHaveCount(0);
    for (const value of cachedValues) {
      await expect(this.page.getByText(value, { exact: true })).toHaveCount(0);
    }
  }

  async signOut(): Promise<void> {
    const account = this.page.getByRole("button", { name: this.accountEmail });
    if ((await account.count()) > 0) {
      await account.click();
      await this.page.getByRole("menuitem", { name: "Sign out" }).click();
    } else {
      await this.page.getByRole("button", { name: "Sign out" }).click();
    }
    await expect(this.page.getByRole("form", { name: "Sign in" })).toBeVisible();
    await expect
      .poll(async () =>
        (await this.context.cookies()).some(({ name }) => name.includes("session_token")),
      )
      .toBe(false);
  }

  private async expectCurrentDaemonAbsent(displayName: string): Promise<void> {
    await this.page.getByRole("link", { name: "Daemons", exact: true }).click();
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/daemons$/u);
    await expect(this.page.getByRole("heading", { name: "Daemons" })).toBeVisible();
    await expect(this.page.getByRole("row").filter({ hasText: displayName })).toHaveCount(0);
  }

  private async submitOrganization(name: string): Promise<void> {
    await this.page.getByRole("button", { name: "Create an organization" }).click();
    const form = this.page.getByRole("form", { name: "Create organization" });
    await expect(form).toBeVisible();
    await form.getByLabel("Organization name").fill(name);
    await form.getByRole("button", { name: "Create organization" }).click();
  }

  private async openOrganizationSection(
    name: "Projects" | "Daemons" | "Connections" | "Team" | "API keys" | "Entitlements",
  ): Promise<void> {
    const mobileSidebar = this.page.getByRole("button", { name: "Toggle Sidebar" });
    if (await mobileSidebar.isVisible().catch(() => false)) {
      await this.navigation.openMobileOrganizationSection(name);
    } else {
      await this.navigation.openOrganizationSection(name);
    }
    await expect(this.page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
  }

  private async refreshOrganizationSection(name: "Daemons" | "Connections" | "Team") {
    await this.openOrganizationSection("Projects");
    await this.openOrganizationSection(name);
    await this.page.reload();
  }

  private connectionRow(provider: string): Locator {
    return this.page
      .getByRole("table", { name: "Connections" })
      .getByRole("row")
      .filter({ has: this.page.getByRole("cell", { name: provider, exact: true }) });
  }

  private async chooseOption(select: Locator, option: string): Promise<void> {
    await select.click();
    const listbox = this.page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    await listbox.getByRole("option", { name: option, exact: true }).click();
    await expect(listbox).toBeHidden();
    await expect(select).toHaveText(option);
  }
}

async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

function roleLabel(role: "owner" | "admin" | "member"): string {
  return role[0]!.toUpperCase() + role.slice(1);
}

class ContractDaemon {
  readonly daemonId = randomUUID();
  readonly slug: string;
  private readonly credential = randomUUID();
  private readonly executionCapabilities = new Map<
    string,
    { url: string; headers: Record<string, string> }
  >();
  private socket: WebSocket | undefined;
  private webSocketUrl = "";

  constructor(
    private readonly application: BuiltApplication,
    private readonly requests: APIRequestContext,
    friendlyName?: string,
  ) {
    const fallback = `daemon-${this.daemonId.slice(0, 8)}`;
    this.slug = friendlyName === undefined ? fallback : slugify(friendlyName, fallback);
  }

  async enroll(token: string): Promise<void> {
    const response = await this.requests.post(`${this.application.origin}/api/daemons/enroll`, {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      data: daemonEnrollment(this.daemonId, this.credential),
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe(JSON_TYPE);
    const body = z
      .object({
        daemonId: z.literal(this.daemonId),
        slug: z.literal(this.slug),
        scopes: z.tuple([z.literal("hub.execution.*")]),
        webSocketUrl: z.string().url(),
      })
      .strict()
      .parse(await response.json());
    this.webSocketUrl = body.webSocketUrl;
  }

  async connect(): Promise<void> {
    const socket = new WebSocket(this.webSocketUrl, {
      headers: {
        authorization: `Bearer ${this.credential}`,
        "x-paseo-daemon-id": this.daemonId,
      },
    });
    socket.on("message", (data) => this.acceptExecution(data));
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
  }

  executionCapability(executionId: string): { url: string; headers: Record<string, string> } {
    return z
      .object({ url: z.string().url(), headers: z.record(z.string(), z.string()) })
      .parse(this.executionCapabilities.get(executionId));
  }

  async expectUnauthorizedRevocation(): Promise<void> {
    const response = await this.requests.delete(
      `${this.application.origin}/api/daemons/${this.daemonId}`,
      { headers: { authorization: "Bearer wrong-credential" } },
    );
    expect(response.status()).toBe(401);
    expect(await response.text()).toBe('{"error":"unauthorized"}');
    expect(response.headers()["content-type"]).toBe(JSON_TYPE);
  }

  async revoke(): Promise<void> {
    const response = await this.requests.delete(
      `${this.application.origin}/api/daemons/${this.daemonId}`,
      { headers: { authorization: `Bearer ${this.credential}` } },
    );
    expect(response.status()).toBe(204);
    expect(await response.body()).toEqual(Buffer.alloc(0));
  }

  async close(): Promise<void> {
    this.socket?.close();
  }

  private acceptExecution(data: RawData): void {
    const envelope = ExecutionRequestSchema.safeParse(JSON.parse(readSocketData(data)));
    if (!envelope.success) return;
    const request = envelope.data.message;
    const capability = request.mcpServers?.["hub"];
    if (capability !== undefined) this.executionCapabilities.set(request.executionId, capability);
    this.socket?.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "hub.execution.agent.create.response",
          payload: {
            requestId: request.requestId,
            executionId: request.executionId,
            agentId: `agent-${request.executionId}`,
            agent: { id: `agent-${request.executionId}`, status: "running" },
            success: true,
            error: null,
          },
        },
      }),
    );
  }
}

interface HttpContract {
  name: string;
  request: HttpRequest;
  expected: HttpResponse;
}

interface HttpRequest {
  path: string;
  method: "GET" | "POST" | "DELETE" | "PUT";
  headers?: Record<string, string>;
  body?: string;
}

interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const WEBHOOK_SECRET = "phase-zero-webhook-secret";
const HOSTILE_ORIGIN = "https://hostile.invalid";
const JSON_TYPE = "application/json";
const ORGANIZATION_POST_PATHS = [
  "/api/auth/paseo/create-organization",
  "/api/auth/paseo/select-organization",
] as const;
const TEXT_TYPE = "text/plain;charset=UTF-8";
const HTML_TYPE = "text/html; charset=utf-8";

function manualFailureContracts(): readonly HttpContract[] {
  return [
    exact("health", "/health", "GET", 200, '{"ok":true}', JSON_TYPE),
    exact(
      "enrollment token requires machine authentication",
      "/api/daemons/enrollment-tokens",
      "POST",
      401,
      '{"error":"unauthorized"}',
      JSON_TYPE,
    ),
    exact(
      "daemon enrollment requires a token",
      "/api/daemons/enroll",
      "POST",
      401,
      '{"error":"unauthorized"}',
      JSON_TYPE,
    ),
    exact(
      "daemon revocation conceals missing daemons",
      "/api/daemons/00000000-0000-4000-8000-000000000000",
      "DELETE",
      401,
      '{"error":"unauthorized"}',
      JSON_TYPE,
    ),
    exact(
      "execution completion requires a token",
      "/agent-executions/00000000-0000-4000-8000-000000000000/mcp",
      "POST",
      401,
      '{"error":"unauthorized"}',
      JSON_TYPE,
    ),
    exact(
      "configuration install requires admin",
      "/api/configurations/install",
      "POST",
      401,
      '{"error":"unauthorized"}',
      JSON_TYPE,
    ),
    exact(
      "manual run requires admin",
      "/api/manual-runs",
      "POST",
      401,
      '{"error":"unauthorized"}',
      JSON_TYPE,
    ),
    exact(
      "obsolete test trigger is unavailable",
      "/test/trigger",
      "POST",
      404,
      "Not Found",
      TEXT_TYPE,
    ),
    exact("obsolete test smoke is unavailable", "/test/smoke", "POST", 404, "Not Found", TEXT_TYPE),
    exact("webhook requires a signature", "/webhook", "POST", 401, "Unauthorized", TEXT_TYPE),
    exact(
      "invalid configuration is not activated",
      "/api/configurations/install",
      "POST",
      422,
      '{"error":"invalid_yaml"}',
      JSON_TYPE,
      { ...machineHeaders(), "content-type": "application/json" },
      JSON.stringify({ projectSlug: "default", yaml: "environments: [" }),
    ),
    exact(
      "unknown manual config is visible",
      "/api/manual-runs",
      "POST",
      404,
      '{"error":"project_not_found"}',
      JSON_TYPE,
      { ...machineHeaders(), "content-type": "application/json" },
      JSON.stringify({
        projectSlug: "missing",
        trigger: "deploy",
        actor: "contract-operator",
        deliveryKey: "missing",
        input: {},
      }),
    ),
  ];
}

const WEBHOOK_SOURCE_CONTRACTS: readonly HttpContract[] = [
  exact(
    "manual trigger is unavailable in webhook mode",
    "/test/trigger",
    "POST",
    404,
    "Not Found",
    TEXT_TYPE,
  ),
  exact(
    "manual smoke is unavailable in webhook mode",
    "/test/smoke",
    "POST",
    404,
    "Not Found",
    TEXT_TYPE,
  ),
  exact("webhook requires a signature", "/webhook", "POST", 401, "Unauthorized", TEXT_TYPE),
];

const ExecutionRequestSchema = z.object({
  type: z.literal("session"),
  message: z.object({
    type: z.literal("hub.execution.agent.create.request"),
    requestId: z.string(),
    executionId: z.string(),
    env: z.record(z.string(), z.string()).optional(),
    mcpServers: z
      .record(
        z.string(),
        z.object({
          type: z.literal("http"),
          url: z.string().url(),
          headers: z.record(z.string(), z.string()).default({}),
        }),
      )
      .optional(),
  }),
});

function exact(
  name: string,
  path: string,
  method: HttpRequest["method"],
  status: number,
  body: string,
  contentType: string,
  headers?: Record<string, string>,
  requestBody?: string,
): HttpContract {
  return {
    name,
    request: {
      path,
      method,
      ...(headers === undefined ? {} : { headers }),
      ...(requestBody === undefined ? {} : { body: requestBody }),
    },
    expected: { status, body, headers: { "content-type": contentType } },
  };
}

function machineHeaders(): Record<string, string> {
  return { authorization: `Bearer ${MACHINE_KEY}` };
}

function daemonEnrollment(daemonId: string, credential: string) {
  return {
    daemonId,
    idempotencyKey: randomUUID(),
    serverId: randomUUID(),
    daemonPublicKey: "built-contract-public-key",
    credentialVerifier: createHash("sha256").update(credential).digest("base64url"),
  };
}

function providerDispatchConfiguration(repo: string, guildId: string) {
  return {
    environments: [
      {
        name: "shared",
        kind: "daemon" as const,
        daemon: "shared-dispatch",
        cwd: "/workspace",
      },
    ],
    triggers: [
      {
        name: "github-dispatch",
        on: "github.issue_comment",
        max_runtime: "1h",
        filters: { repo, from_users: ["alice"] },
        steps: [
          {
            id: "github-dispatch-step",
            environment: "shared",
            max_runtime: "30m",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "full-access" },
            prompt: [{ text: "Handle GitHub tenant dispatch" }],
          },
        ],
      },
      {
        name: "discord-dispatch",
        on: "discord.mention",
        max_runtime: "1h",
        filters: { guild: guildId, from_users: ["800"] },
        steps: [
          {
            id: "discord-dispatch-step",
            environment: "shared",
            max_runtime: "30m",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "full-access" },
            prompt: [{ text: "Handle Discord tenant dispatch" }],
          },
        ],
      },
    ],
  };
}

function githubIssueCommentPayload(installationId: number, repo: string, actor: string) {
  return {
    action: "created",
    sender: { login: actor },
    comment: { id: installationId, body: "@paseo run tenant dispatch", user: { login: actor } },
    issue: { number: installationId },
    repository: { id: installationId, full_name: repo },
    installation: { id: installationId },
  };
}

function dispatchEvidence(deliveryId: string, organizationId: string, daemonId: string) {
  return {
    delivery_id: deliveryId,
    trigger_organization_id: organizationId,
    config_organization_id: organizationId,
    machine_organization_id: organizationId,
    daemon_id: daemonId,
    daemon_slug: "shared-dispatch",
    execution_id: expect.any(String),
  };
}

function manualConfiguration(daemonSlug: string): string {
  return [
    "environments:",
    "  - name: production",
    "    kind: daemon",
    `    daemon: ${daemonSlug}`,
    "    cwd: /workspace",
    "triggers:",
    "  - name: deploy",
    "    on: manual.run",
    "    max_runtime: 1h",
    "    filters:",
    "      from_users: [contract-operator]",
    "    steps:",
    "      - id: deploy-step",
    "        environment: production",
    "        max_runtime: 30m",
    "        idle_timeout: 5m",
    "        agent:",
    "          provider: opencode",
    "          mode: full-access",
    '        prompt: [{ text: "Deploy the contract" }]',
  ].join("\n");
}

function readSocketData(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return Buffer.from(data).toString();
}

async function retryUntil<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  let value = await read();
  while (!done(value)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for durable provider dispatch");
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  return value;
}
