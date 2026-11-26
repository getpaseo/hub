import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { z } from "zod";
import { AgentSessions } from "../../agent-sessions/index.js";
import { createApplicationRuntime } from "../../application-runtime.js";
import { composeEntitlements } from "../../auth/entitlements.js";
import type { AccountAccessValue } from "../../auth/organization-access.js";
import { createAuthServer } from "../../auth/server.js";
import { createDatabase } from "../../db/pg.js";
import { embeddedDatabaseRuntime } from "../../db/runtime/index.js";
import { OutputExecutorRegistry } from "../../execution-capabilities/outputs.js";
import { HomeDashboard } from "../../home/dashboard.js";
import { callIntegrationTool } from "../../integration-tools/index.js";
import { ProjectDashboard } from "../../projects/dashboard.js";
import {
  ProviderApplicationError,
  activateProviderApplicationsAtStartup,
  createProviderApplicationInventory,
  createProviderApplicationStore,
  createProviderApplicationVerifier,
  createProviderApplications,
  DynamicProviderRuntime,
} from "../../provider-applications/index.js";
import { compileTriggerDocument } from "../../triggers/configuration/index.js";
import { createTriggerYaml } from "../../triggers/configuration/editor.js";
import { defaultBrowserIntegrationRegistry } from "../browser-registry.js";
import { defaultIntegrationRegistry } from "../registry.js";

function requestUrl(input: string | URL | Request): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function parseJsonBody(init?: RequestInit): Record<string, string> {
  if (typeof init?.body !== "string") return {};
  return z.record(z.string(), z.string()).parse(JSON.parse(init.body));
}

const StatusViewSchema = z.object({
  notion: z.object({
    status: z.string(),
    identifiers: z.record(z.string(), z.string()).optional(),
  }),
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createIntegrationTestHarness() {
  return {
    async verifyEnvironmentInternal(input: {
      providerStore: ReturnType<typeof createProviderApplicationStore>;
      dynamicRuntime: DynamicProviderRuntime;
      providerVerifier: ReturnType<typeof createProviderApplicationVerifier>;
      providerInventory: ReturnType<typeof createProviderApplicationInventory>;
      application: Awaited<ReturnType<typeof createApplicationRuntime>>;
      database: ReturnType<typeof createDatabase>;
      organizationId: string;
      organizationSlug: string;
      authedRequest: (url: string, method?: string) => Request;
    }): Promise<void> {
      await activateProviderApplicationsAtStartup({
        store: input.providerStore,
        environment: {
          registered: {
            notion: {
              provider: "notion",
              mode: "internal",
              apiToken: "ntn_internal_valid",
            },
          },
        },
        runtime: input.dynamicRuntime,
        verifier: input.providerVerifier,
        inventory: input.providerInventory,
        callbackOrigin: "https://hub.test",
        registry: defaultIntegrationRegistry,
      });

      const envStatusBefore = await input.application.connectionStatus(
        input.authedRequest(
          `https://hub.test/connections?organizationSlug=${encodeURIComponent(input.organizationSlug)}`,
        ),
      );
      const envParsedBefore = StatusViewSchema.parse(await envStatusBefore.json());
      assert.equal(envParsedBefore.notion.status, "disconnected");

      const envConnectRes = await input.application.connectionAction(
        input.authedRequest(
          `https://hub.test/connections/start?organizationSlug=${encodeURIComponent(input.organizationSlug)}`,
          "POST",
        ),
        "notion",
        "start",
      );
      assert.equal(envConnectRes.status, 200);
      const envConnectUrl = z.object({ url: z.string() }).parse(await envConnectRes.json()).url;
      assert.match(envConnectUrl, /result=notion_connected/u);

      const envStatusAfter = await input.application.connectionStatus(
        input.authedRequest(
          `https://hub.test/connections?organizationSlug=${encodeURIComponent(input.organizationSlug)}`,
        ),
      );
      const envParsedAfter = StatusViewSchema.parse(await envStatusAfter.json());
      assert.equal(envParsedAfter.notion.status, "connected");
      assert.equal(
        defaultBrowserIntegrationRegistry
          .get("notion")
          ?.setup.supportsOrgConnect?.(envParsedAfter.notion.identifiers ?? {}),
        false,
      );

      const envConns = await input.database.integrations.listForOrganization(
        input.organizationId,
        "notion",
      );
      assert.equal(envConns.length, 1);
      assert.equal(envConns[0]?.credentials["accessToken"], "ntn_internal_valid");
    },
  };
}

describe("Notion PR 2 embedded Postgres end-to-end", () => {
  it("verifies Internal Connection, Public OAuth lifecycle, withRefreshLock, invalid_grant, revoke, and AgentSessions MCP tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-notion-pr2-"));
    const { runtime, locks } = await embeddedDatabaseRuntime(join(root, "database"));
    await runtime.migrate();
    const database = createDatabase(runtime, locks);
    const entitlements = composeEntitlements(database, runtime);
    const auth = createAuthServer({
      database: runtime,
      locks,
      entitlements: entitlements.service,
      secret: "notion-pr2-test-secret".padEnd(32, "-"),
      baseURL: "https://hub.test",
      policy: {
        registrationMode: "invite_only",
        organizationCreation: "disabled",
        bootstrap: {
          ownerEmail: "owner@notion.test",
          ownerPassword: "owner-password-1234",
          organizationName: "Notion Org",
        },
      },
    });

    const WS_ID = "22222222-2222-4222-8222-222222222222";
    const BOT_INTERNAL = "11111111-1111-4111-8111-111111111111";
    const BOT_OAUTH = "33333333-3333-4333-8333-333333333333";
    const DS_ID = "248104cd-477e-80af-bc30-000bd28de8f9";
    const PAGE_ID = "153104cd-477e-809d-8dc4-ff2d96ae3090";

    let nowMs = Date.parse("2026-11-26T12:00:00Z");
    const revokedTokens: string[] = [];
    let refreshMode: "ok" | "invalid_grant" = "ok";
    let refreshCount = 0;

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);

      if (url.pathname === "/v1/users/me") {
        if (headers.get("authorization") === "Bearer ntn_internal_valid") {
          return jsonResponse({
            object: "user",
            id: BOT_INTERNAL,
            type: "bot",
            name: "Paseo Internal",
            bot: {
              owner: { type: "workspace", workspace: true },
              workspace_id: WS_ID,
              workspace_name: "Eng Notion",
            },
          });
        }
        return jsonResponse({ code: "unauthorized" }, 401);
      }

      if (url.pathname === "/v1/oauth/token") {
        const body = parseJsonBody(init);
        if (body["grant_type"] === "authorization_code") {
          return jsonResponse({
            access_token: "oauth-token-v1",
            refresh_token: "oauth-refresh-v1",
            expires_in: 3600,
            bot_id: BOT_OAUTH,
            workspace_id: WS_ID,
            workspace_name: "Eng OAuth Notion",
            owner: { type: "user", user: { id: "user-notion-1" } },
          });
        }
        if (body["grant_type"] === "refresh_token") {
          refreshCount += 1;
          if (refreshMode === "invalid_grant") {
            return jsonResponse({ error: "invalid_grant" }, 400);
          }
          return jsonResponse({
            access_token: "oauth-token-v2",
            refresh_token: "oauth-refresh-v2",
            expires_in: 3600,
            bot_id: BOT_OAUTH,
            workspace_id: WS_ID,
            workspace_name: "Eng OAuth Notion",
          });
        }
      }

      if (url.pathname === "/v1/oauth/revoke") {
        const body = parseJsonBody(init);
        revokedTokens.push(body["token"] ?? "");
        return jsonResponse({});
      }

      if (url.pathname === `/v1/pages/${PAGE_ID}`) {
        if (headers.get("authorization") === "Bearer oauth-token-v1") {
          return jsonResponse({ code: "unauthorized" }, 401);
        }
        return jsonResponse({
          id: PAGE_ID,
          url: `https://www.notion.so/${PAGE_ID.replaceAll("-", "")}`,
          parent: { type: "data_source_id", data_source_id: DS_ID },
          properties: { Name: { type: "title", title: [{ plain_text: "Spec" }] } },
        });
      }

      if (url.pathname === `/v1/pages/${PAGE_ID}/markdown`) {
        return jsonResponse({
          markdown: "# Spec\n\nDetails",
          truncated: false,
          unknown_block_ids: [],
        });
      }

      return jsonResponse({ code: "object_not_found" }, 404);
    };

    const providerStore = createProviderApplicationStore(
      runtime,
      locks,
      database,
      defaultIntegrationRegistry,
    );
    const providerInventory = createProviderApplicationInventory(runtime);
    const providerVerifier = createProviderApplicationVerifier({
      fetch: fakeFetch,
      now: () => nowMs,
      registry: defaultIntegrationRegistry,
    });
    const dynamicRuntime = new DynamicProviderRuntime({
      database,
      auth,
      applicationBaseUrl: "https://hub.test",
      fetch: fakeFetch,
      now: () => new Date(nowMs),
      registry: defaultIntegrationRegistry,
    });

    const application = await createApplicationRuntime({
      database,
      auth,
      entitlements: entitlements.service,
      billing: null,
      registrations: dynamicRuntime.registrations(),
      publicBaseUrl: "https://hub.test",
      async close() {
        await auth.close();
        await entitlements.close();
        await database.close();
      },
    });

    try {
      await auth.initialize?.();
      const ownerRow = await runtime.query<{
        membership_id: string;
        organization_id: string;
        organization_slug: string;
        project_id: string;
        user_id: string;
      }>(
        `select member.id as membership_id, member.organization_id,
                organization.slug as organization_slug,
                projects.id as project_id, member.user_id
           from member
           join organization on organization.id = member.organization_id
           join projects on projects.organization_id = member.organization_id
           where member.role = 'owner'`,
      );
      const owner = ownerRow.rows[0]!;
      const signIn = await auth.handle(
        new Request("https://hub.test/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://hub.test" },
          body: JSON.stringify({
            email: "owner@notion.test",
            password: "owner-password-1234",
          }),
        }),
      );
      assert.equal(signIn.status, 200);
      const initialCookie = signIn.headers
        .getSetCookie()
        .map((c) => c.split(";")[0]!)
        .join("; ");
      await auth.changePassword!(
        { currentPassword: "owner-password-1234", newPassword: "owner-password-5678" },
        new Headers({ cookie: initialCookie, origin: "https://hub.test" }),
      );
      const freshSignIn = await auth.handle(
        new Request("https://hub.test/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://hub.test" },
          body: JSON.stringify({
            email: "owner@notion.test",
            password: "owner-password-5678",
          }),
        }),
      );
      const cookieHeader = freshSignIn.headers
        .getSetCookie()
        .map((c) => c.split(";")[0]!)
        .join("; ");
      const authedRequest = (url: string, method = "GET") =>
        new Request(url, {
          method,
          headers: { cookie: cookieHeader, origin: "https://hub.test" },
        });
      const resolvedAccount = await auth.resolveAccount(authedRequest("https://hub.test/apps"));
      const fakeAccount: AccountAccessValue = {
        session: { id: resolvedAccount.session.id, activeOrganizationId: owner.organization_id },
        account: { id: owner.user_id, name: "Owner", email: "owner@notion.test" },
        isInstanceOperator: true,
      };
      const providerApplications = createProviderApplications({
        auth: {
          resolveAccount: async () => fakeAccount,
          rejectCookieMutation: () => undefined,
        },
        store: providerStore,
        environment: {},
        runtime: dynamicRuntime,
        verifier: providerVerifier,
        inventory: providerInventory,
        callbackOrigin: () => "https://hub.test",
        registry: defaultIntegrationRegistry,
        database,
        fetch: fakeFetch,
        now: () => new Date(nowMs),
        beginCandidateConnection: async (req, _orgId, _returnRoute, begin) => begin(req),
      });

      // 1. Invalid internal token rejected cleanly
      await assert.rejects(
        providerApplications.verifyAndSave(
          authedRequest("https://hub.test/apps", "POST"),
          "notion",
          { provider: "notion", mode: "internal", apiToken: "ntn_bad" },
        ),
        (err: unknown) =>
          err instanceof ProviderApplicationError && err.code === "credentialsRejected",
      );

      // 2. Valid internal token verifies and binds connection atomically
      const internalSave = await providerApplications.verifyAndSave(
        authedRequest("https://hub.test/apps", "POST"),
        "notion",
        { provider: "notion", mode: "internal", apiToken: "ntn_internal_valid" },
      );
      assert.equal(internalSave.status, "verified");

      // connectionStatus includes identifiers.mode === "internal", so supportsOrgConnect hides Connect button
      const internalStatusRes = await application.connectionStatus(
        authedRequest(
          `https://hub.test/connections?organizationSlug=${encodeURIComponent(owner.organization_slug)}`,
        ),
      );
      const internalStatusBody = StatusViewSchema.parse(await internalStatusRes.json());
      assert.equal(internalStatusBody.notion.status, "connected");
      assert.equal(
        defaultBrowserIntegrationRegistry
          .get("notion")
          ?.setup.supportsOrgConnect?.(internalStatusBody.notion.identifiers ?? {}),
        false,
      );

      const internalConns = await database.integrations.listForOrganization(
        owner.organization_id,
        "notion",
      );
      assert.equal(internalConns.length, 1);

      // Compile trigger YAML with Notion grant + verify AgentSessions link hint & tool execution
      await database.issueEnrollmentToken({
        id: randomUUID(),
        verifier: "notion-enroll-verifier",
        organizationId: owner.organization_id,
        issuedByApiKeyId: null,
        expiresAt: new Date(nowMs + 60_000),
        consumedAt: null,
      });
      const daemonResult = await database.enrollDaemon({
        daemonId: randomUUID(),
        idempotencyKey: "notion-enroll-idem",
        tokenVerifier: "notion-enroll-verifier",
        suggestedSlug: "mac-1",
        serverId: "srv-1",
        daemonPublicKey: "pub-1",
        credentialVerifier: "cred-1",
        permissions: ["hub.execute"],
        now: new Date(nowMs),
      });
      if (daemonResult === undefined || daemonResult.status === "slug_conflict") {
        throw new Error("expected enrolled daemon");
      }
      const yaml = createTriggerYaml({
        name: "notion-check",
        enabled: true,
        event: "schedule.tick",
        connection: "",
        audience: "everyone",
        allowedUsers: "",
        qualifiers: {},
        daemon: "mac-1",
        cwd: "/workspace/repo",
        agent: "claude/sonnet",
        mode: "",
        thinkingOptionId: "",
        providerOptions: "",
        continuationMode: "conversation",
        continuationKey: "",
        maxRuntime: "2h",
        idleTimeout: "10m",
        background: false,
        autoArchive: true,
        githubConnection: "",
        githubRepositories: "",
        githubPermissions: "",
        githubDuration: "",
        tools: {},
        integrationTools: {
          notion: {
            enabled: true,
            connection: internalConns[0]!.slug,
            actions: ["read", "comment"],
            fields: {
              data_sources: DS_ID,
              pages: "",
            },
          },
        },
        prompt: "Review Notion spec.",
      });
      const compiled = compileTriggerDocument(yaml, defaultIntegrationRegistry);
      const grants = compiled.events[0]!.steps[0]!.tools!;

      const sentPrompts: string[] = [];
      const exec = await database.insertAgentExecution({
        organizationId: owner.organization_id,
        projectId: owner.project_id,
        machineId: null,
        daemonId: daemonResult.id,
        configurationRevisionId: (
          await database.insertProjectConfigurationRevision({
            projectId: owner.project_id,
            sourceKind: "manual",
            sourceEvidence: { kind: "test" },
            normalizedConfiguration: {
              environments: [compiled.environment],
              triggers: compiled.events,
            },
            contentHash: "hash-notion-1",
          })
        ).id,
        triggerContext: {},
        outputContext: {},
      });
      const sessions = new AgentSessions(
        database,
        "session-secret-01234567890123456789",
        "https://hub.test",
        new OutputExecutorRegistry(),
        () => nowMs,
        defaultIntegrationRegistry,
      );
      const dispatched = await sessions.dispatch({
        executionId: exec.id,
        intent: {
          kind: "launch_machine",
          organizationId: owner.organization_id,
          projectId: owner.project_id,
          triggerRunId: randomUUID(),
          triggerName: "notion-check",
          environmentName: "target",
          configurationRevisionId: exec.configurationRevisionId,
          prompt: "Review Notion spec.",
          agent: { provider: "claude" },
          environment: {
            kind: "daemon",
            daemonId: daemonResult.id,
            authoredSlug: "mac-1",
            cwd: "/repo",
            env: {},
          },
          env: {},
          tools: grants,
          allowOutputs: [],
          triggerContext: {},
          outputContext: {},
          hubConfig: { environments: [compiled.environment], triggers: compiled.events },
          autoArchive: true,
          background: false,
        },
        connection: {
          create: async () => ({ id: "a-1", workspaceId: "w-1", status: "idle" }),
          get: async () => ({ id: "a-1", workspaceId: "w-1", status: "idle", archivedAt: null }),
          restore: async () => true,
          watch: async () => () => {},
          send: async (_a, _e, prompt) => {
            sentPrompts.push(prompt);
          },
          control: async () => {},
        },
        createOptions: async () => ({ provider: "claude", cwd: "/repo", env: {} }),
        onEvent: () => {},
      });
      dispatched.unsubscribe();
      assert.match(sentPrompts[0]!, /For Notion use \[Open in Paseo\]\(https:\/\/hub\.test\//u);

      // Disconnect internal connection before testing Public OAuth mode
      const disconnectInternal = await application.connectionAction(
        authedRequest(
          `https://hub.test/connections/disconnect?organizationSlug=${encodeURIComponent(owner.organization_slug)}&connectionId=${encodeURIComponent(internalConns[0]!.id)}`,
          "POST",
        ),
        "notion",
        "disconnect",
      );
      assert.equal(disconnectInternal.status, 200);
      assert.deepEqual(revokedTokens, []);

      // 3. Public OAuth mode: savingContinues -> authorize URL -> callback -> bound
      const oauthSave = await providerApplications.verifyAndSave(
        authedRequest(
          `https://hub.test/apps?organizationSlug=${encodeURIComponent(owner.organization_slug)}&returnRoute=%2Fapps`,
          "POST",
        ),
        "notion",
        {
          provider: "notion",
          mode: "oauth",
          clientId: "notion-client-1",
          clientSecret: "notion-secret-1",
          expectedVersion: internalSave.configurationVersion,
        },
      );
      assert.equal(oauthSave.status, "continuing");
      if (oauthSave.status !== "continuing") throw new Error("expected oauth continuation");
      const authUrl = new URL(oauthSave.url);
      assert.equal(authUrl.origin + authUrl.pathname, "https://api.notion.com/v1/oauth/authorize");
      assert.equal(authUrl.searchParams.get("owner"), "user");
      const state = authUrl.searchParams.get("state")!;

      // Cancelled OAuth callback redirects cleanly with notion_cancelled
      const cancelSave = await providerApplications.verifyAndSave(
        authedRequest(
          `https://hub.test/apps?organizationSlug=${encodeURIComponent(owner.organization_slug)}&returnRoute=%2Fapps`,
          "POST",
        ),
        "notion",
        {
          provider: "notion",
          mode: "oauth",
          clientId: "notion-client-1",
          clientSecret: "notion-secret-1",
          expectedVersion: internalSave.configurationVersion,
        },
      );
      assert.equal(cancelSave.status, "continuing");
      if (cancelSave.status !== "continuing") throw new Error("expected continuation");
      const cancelState = new URL(cancelSave.url).searchParams.get("state")!;
      const cancelledRes = await application.connectionAction(
        authedRequest(
          `https://hub.test/api/integrations/notion/callback?state=${encodeURIComponent(cancelState)}&error=access_denied`,
        ),
        "notion",
        "callback",
      );
      assert.equal(cancelledRes.status, 303);
      assert.match(cancelledRes.headers.get("location") ?? "", /result=notion_cancelled/u);

      // Successful OAuth callback binds connection and activates app configuration
      const cbRes = await application.connectionAction(
        authedRequest(
          `https://hub.test/api/integrations/notion/callback?state=${encodeURIComponent(state)}&code=auth-code-1`,
        ),
        "notion",
        "callback",
      );
      assert.equal(cbRes.status, 303);
      assert.match(cbRes.headers.get("location") ?? "", /result=notion_connected/u);

      const oauthStatusRes = await application.connectionStatus(
        authedRequest(
          `https://hub.test/connections?organizationSlug=${encodeURIComponent(owner.organization_slug)}`,
        ),
      );
      const oauthStatusBody = StatusViewSchema.parse(await oauthStatusRes.json());
      assert.equal(
        defaultBrowserIntegrationRegistry
          .get("notion")
          ?.setup.supportsOrgConnect?.(oauthStatusBody.notion.identifiers ?? {}),
        true,
      );

      const oauthConns = await database.integrations.listForOrganization(
        owner.organization_id,
        "notion",
      );
      assert.equal(oauthConns.length, 1);

      // 4. Reactive refresh-on-401 via real Postgres withRefreshLock
      const handler = defaultIntegrationRegistry.get("notion")!.tools!.createHandler(
        {
          provider: "notion",
          mode: "oauth",
          clientId: "notion-client-1",
          clientSecret: "notion-secret-1",
        },
        {
          database,
          auth,
          callbackOrigin: "https://hub.test",
          identity: { provider: "notion", id: "notion-client-1", name: "Notion app" },
          configurationVersion: 2,
          fetch: fakeFetch,
          now: () => new Date(nowMs),
          ingest: { enqueue: async () => ({ status: "accepted" }) },
        },
      );
      const oauthGrant = {
        connection: oauthConns[0]!.slug,
        actions: ["read"] as const,
        data_sources: [DS_ID],
      };
      const [callA, callB] = await Promise.all([
        callIntegrationTool({
          name: "notion_read_page",
          organizationId: owner.organization_id,
          grants: { notion: oauthGrant },
          handlers: { registered: { notion: handler } },
          args: { page: PAGE_ID },
        }),
        callIntegrationTool({
          name: "notion_read_page",
          organizationId: owner.organization_id,
          grants: { notion: oauthGrant },
          handlers: { registered: { notion: handler } },
          args: { page: PAGE_ID },
        }),
      ]);
      const markdownSchema = z.object({ markdown: z.string() });
      assert.equal(refreshCount, 1);
      assert.equal(markdownSchema.parse(callA?.value).markdown, "# Spec\n\nDetails");
      assert.equal(markdownSchema.parse(callB?.value).markdown, "# Spec\n\nDetails");

      // 5. Proactive refresh + invalid_grant transitions connection to requiresReauthorization in Home/Project snapshots
      nowMs += 58 * 60_000;
      refreshMode = "invalid_grant";
      await assert.rejects(
        callIntegrationTool({
          name: "notion_read_page",
          organizationId: owner.organization_id,
          grants: { notion: oauthGrant },
          handlers: { registered: { notion: handler } },
          args: { page: PAGE_ID },
        }),
      );

      const projectDash = new ProjectDashboard(
        database,
        auth,
        () => new Date(nowMs),
        defaultIntegrationRegistry,
      );
      const orgSnap = await projectDash.organizationSnapshot(
        authedRequest(`https://hub.test/o/${owner.organization_slug}/integrations`),
        { organizationSlug: owner.organization_slug },
      );
      assert.equal(orgSnap.connections.integrations[0]?.status, "requiresReauthorization");

      const homeDash = new HomeDashboard(
        database,
        auth,
        () => true,
        () => new Date(nowMs),
        defaultIntegrationRegistry,
      );
      const homeSnap = await homeDash.snapshot(
        authedRequest(`https://hub.test/o/${owner.organization_slug}`),
        owner.organization_slug,
        "7d",
      );
      assert.equal(
        homeSnap.connections.find((c) => c.provider === "notion")?.status,
        "requiresReauthorization",
      );

      // 6. Disconnect triggers best-effort POST /v1/oauth/revoke
      const disconnectOAuth = await application.connectionAction(
        authedRequest(
          `https://hub.test/connections/disconnect?organizationSlug=${encodeURIComponent(owner.organization_slug)}&connectionId=${encodeURIComponent(oauthConns[0]!.id)}`,
          "POST",
        ),
        "notion",
        "disconnect",
      );
      assert.equal(disconnectOAuth.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepEqual(revokedTokens, ["oauth-token-v2"]);

      // 7. Environment-configured internal Notion activates cleanly and binds on org Connect
      await createIntegrationTestHarness().verifyEnvironmentInternal({
        providerStore,
        dynamicRuntime,
        providerVerifier,
        providerInventory,
        application,
        database,
        organizationId: owner.organization_id,
        organizationSlug: owner.organization_slug,
        authedRequest,
      });
    } finally {
      await application.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
