import type { TriggerLastRun } from "../activity/index.js";
import type { AuthServer } from "../auth/server.js";
import { capabilitiesFor } from "../auth/organization-policy.js";
import type { Database, OrganizationTriggerRecord } from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import { TRUSTED_REQUEST_ORIGIN_HEADER } from "../http/request-origin.js";
import { ProjectCommandError } from "../projects/command-error.js";
import type { DaemonAgentConfigurationValidator } from "../configuration/store.js";
import { projectTriggerForm } from "./configuration/editor.js";
import { eventProvider } from "./configuration/events.js";
import { configuredTriggerEvents, OrganizationTriggerStore } from "./store.js";
import type { WebhookSecretAction } from "./webhook/index.js";

export class TriggerDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly agentValidator: DaemonAgentConfigurationValidator,
    private readonly publicBaseUrl?: string,
  ) {}

  async snapshot(request: Request, organizationSlug: string) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const store = new OrganizationTriggerStore(
      this.database,
      tenant.organization.id,
      this.agentValidator,
    );
    const [triggers, daemons, connections, webhooks, lastRuns] = await Promise.all([
      store.list(),
      this.database.listDaemonsForOrganization(tenant.organization.id),
      this.database.organizationConnectionUsage(tenant.organization.id),
      this.database.webhooks.list(tenant.organization.id),
      this.database.activity.lastRuns(tenant.organization.id),
    ]);
    return {
      organization: tenant.organization,
      canManage: capabilitiesFor(tenant.membership.role).manageResources,
      triggers: await Promise.all(
        triggers.map((trigger) =>
          triggerView(
            store,
            trigger,
            lastRuns.find(({ triggerId }) => triggerId === trigger.id),
          ),
        ),
      ),
      webhooks,
      webhookOrigin: new URL(
        request.headers.get(TRUSTED_REQUEST_ORIGIN_HEADER) ?? this.publicBaseUrl ?? request.url,
      ).origin,
      // Only a daemon that can run agents is a target; one enrolled without `hub.execute` would
      // be refused at save, and Home says how to grant it.
      daemons: daemons
        .filter(
          ({ status, permissions }) => status === "active" && permissions.includes("hub.execute"),
        )
        .map(({ id, slug, presence }) => ({ id, slug, presence })),
      connections: [
        ...connections.slack.map(({ id, slug, teamName }) => ({
          id,
          slug,
          provider: "slack" as const,
          label: teamName,
        })),
        ...connections.discord.map(({ id, slug, guildName }) => ({
          id,
          slug,
          provider: "discord" as const,
          label: guildName,
        })),
        ...connections.github.map(({ id, slug, accountLogin }) => ({
          id,
          slug,
          provider: "github" as const,
          label: accountLogin,
        })),
        ...connections.linear.map(({ id, slug, linearOrganizationName }) => ({
          id,
          slug,
          provider: "linear" as const,
          label: linearOrganizationName,
        })),
      ],
    };
  }

  async rotateWebhookSecret(
    request: Request,
    organizationSlug: string,
    triggerId: string,
    action: WebhookSecretAction = "rotate",
  ) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    if (!capabilitiesFor(tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    return this.database.webhooks.rotate(tenant.organization.id, triggerId, action);
  }

  async save(
    request: Request,
    organizationSlug: string,
    input: { triggerId?: string; yaml: string },
  ) {
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    if (!capabilitiesFor(tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    return new OrganizationTriggerStore(
      this.database,
      tenant.organization.id,
      this.agentValidator,
    ).save({
      ...(input.triggerId === undefined ? {} : { triggerId: input.triggerId }),
      yaml: input.yaml,
      userId: account.account.id,
    });
  }
}

async function triggerView(
  store: OrganizationTriggerStore,
  trigger: OrganizationTriggerRecord,
  lastRun: TriggerLastRun | undefined,
) {
  const revision = await store.activeRevision(trigger);
  const evidence = record(revision.sourceEvidence);
  const event = configuredTriggerEvents(trigger.format, revision)[0] ?? "manual.run";
  const provider = eventProvider(event);
  const lastTriggered =
    lastRun === undefined
      ? null
      : { status: lastRun.status, receivedAt: lastRun.receivedAt.toISOString() };
  if (trigger.format === "legacy_multistep") {
    return {
      id: trigger.id,
      name: trigger.name,
      enabled: trigger.enabled,
      format: trigger.format,
      yaml: revision.yaml,
      updatedAt: trigger.updatedAt.toISOString(),
      blockers: stringArray(evidence?.["conversionBlockers"]),
      draft: null,
      event,
      provider,
      lastTriggered,
    };
  }
  const projection = projectTriggerForm(revision.yaml);
  return {
    id: trigger.id,
    name: trigger.name,
    enabled: trigger.enabled,
    format: trigger.format,
    yaml: revision.yaml,
    updatedAt: trigger.updatedAt.toISOString(),
    blockers: [],
    draft: projection.status === "editable" ? projection.value : null,
    event,
    provider,
    lastTriggered,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
