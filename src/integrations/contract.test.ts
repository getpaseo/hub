import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { describe, it } from "vitest";
import { parseDocument } from "yaml";
import { z } from "zod";
import { AgentSessions } from "../agent-sessions/index.js";
import { createApplicationRuntime } from "../application-runtime.js";
import { composeEntitlements } from "../auth/entitlements.js";
import type { AccountAccessValue } from "../auth/organization-access.js";
import { createAuthServer, type AuthServer } from "../auth/server.js";
import { HubConfigSchema } from "../config/compiler.js";
import {
  ProjectConfigurationStore,
  resolveTriggerConfigurationForOrganization,
} from "../configuration/store.js";
import { connectionReturnCopy } from "../connections/result-contract.js";
import { ConnectionConflictError } from "../db/errors.js";
import { createMemoryDatabase } from "../db/memory.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { OutputExecutorRegistry, replyOutputTool } from "../execution-capabilities/outputs.js";
import { HomeDashboard } from "../home/dashboard.js";
import {
  buildCompiledIntegrationToolGrantsSchema,
  buildIntegrationToolGrantsSchema,
} from "../integration-tools/grants.js";
import { callIntegrationTool, integrationToolDefinitions } from "../integration-tools/index.js";
import { ProjectDashboard } from "../projects/dashboard.js";
import {
  createProviderApplicationInventory,
  createProviderApplications,
  createProviderApplicationStore,
  createProviderApplicationVerifier,
  DynamicProviderRuntime,
  readProviderApplicationEnvironment,
} from "../provider-applications/index.js";
import {
  buildTriggerDocumentSchema,
  compileTriggerDocument,
  TriggerDocumentSchema,
} from "../triggers/configuration/index.js";
import {
  createTriggerYaml,
  patchTriggerYaml,
  projectTriggerForm,
  triggerFormErrors,
} from "../triggers/configuration/editor.js";
import {
  automaticReplyType,
  eventDefinition,
  isEditorEvent,
} from "../triggers/configuration/events.js";
import type { TriggerHandler } from "../triggers/index.js";
import {
  defineBrowserIntegration,
  type BrowserIntegrationDefinition,
} from "./browser-contracts.js";
import {
  createBrowserIntegrationRegistry,
  defaultBrowserIntegrationRegistry,
} from "./browser-registry.js";
import {
  defineIntegration,
  toPublicConnectionView,
  type EventActor,
  type IntegrationInboundEvent,
} from "./contracts.js";
import {
  assertIntegrationRegistriesAligned,
  createIntegrationRegistry,
  defaultIntegrationRegistry,
} from "./registry.js";

const ACME_CONFIG_SCHEMA = z.object({
  provider: z.literal("acme"),
  mode: z.enum(["direct", "oauth"]).default("direct"),
  token: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  webhookSecret: z.string().min(1).optional(),
});

const ACME_IDENTITY_SCHEMA = z.object({
  provider: z.literal("acme"),
  id: z.string().min(1),
  name: z.string().min(1),
});

const ACME_FILTER_SCHEMA = z.object({
  board: z.string().min(1).optional(),
});

const ACME_GRANT_SCHEMA = z.strictObject({
  connection: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  actions: z.array(z.enum(["read", "comment"])).min(1),
  boards: z.array(z.string().min(1)).min(1),
});

const ACME_EVENT_ACTOR_SCHEMA = z.object({
  id: z.string().min(1),
  login: z.string().min(1).optional(),
  isBot: z.boolean(),
  isSelfApp: z.boolean(),
});

const ACME_WEBHOOK_BODY_SCHEMA = z.object({
  deliveryId: z.string().min(1),
  externalId: z.string().min(1),
  cardId: z.string().min(1),
  board: z.string().min(1),
  actor: ACME_EVENT_ACTOR_SCHEMA,
});

const ACME_INGEST_PAYLOAD_SCHEMA = z.object({
  receiptId: z.string().min(1),
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  configurationRevisionId: z.string().min(1),
  cardId: z.string().min(1),
  board: z.string().min(1),
});

const ACME_TRIGGER_PAYLOAD_SCHEMA = z.object({
  cardId: z.string().min(1),
  board: z.string().min(1),
  actor: ACME_EVENT_ACTOR_SCHEMA.nullable(),
});

const ACME_OUTPUT_CONTEXT_SCHEMA = z.object({ cardId: z.string().min(1) });
const ACME_REPLY_ARGS_SCHEMA = z.object({ body: z.string() });
const ACME_DRAFT_GRANT_SCHEMA = z.object({
  connection: z.string().optional(),
  actions: z.array(z.string()).optional(),
  boards: z.array(z.string()).optional(),
});

function stubAuth(): AuthServer {
  return {
    handle: async () => new Response("Not Found", { status: 404 }),
    resolveAccount: async () => {
      throw new Error("auth not configured in unit test");
    },
    resolveOrganizationAccess: async () => {
      throw new Error("auth not configured in unit test");
    },
    resources: async () => {
      throw new Error("auth not configured in unit test");
    },
    rejectCookieMutation: () => undefined,
    close: async () => {},
  };
}

const ACME_CARD_EVENT = {
  id: "acme.card_created" as const,
  label: "Acme card created",
  replyType: "acme.reply",
  qualifiers: [
    {
      key: "board",
      kind: "string" as const,
      label: "Board",
      description: "Only match cards created on this board",
      required: true,
    },
  ],
  audiences: ["everyone" as const, "specific" as const],
  audienceHint: "Acme user IDs who may run this trigger",
};

interface AcmeTestHooks {
  readonly replies: { cardId: string; body: string }[];
  readonly toolCalls: { name: string; connection: string; args: Record<string, unknown> }[];
  readonly revokedTokens: string[];
  readonly actorsSeen: EventActor[];
}

function createAcmeServerIntegration(hooks: AcmeTestHooks) {
  return defineIntegration({
    id: "acme",
    label: "Acme",
    resourceNoun: "Board",
    connection: {
      configSchema: ACME_CONFIG_SCHEMA,
      identitySchema: ACME_IDENTITY_SCHEMA,
      readEnvironment(env) {
        const token = env["ACME_TOKEN"]?.trim();
        if (token === undefined || token.length === 0) return undefined;
        return { provider: "acme" as const, mode: "direct" as const, token };
      },
      sensitiveValues(config) {
        return [config.token, config.clientSecret, config.webhookSecret].filter(
          (value): value is string => value !== undefined && value.length > 0,
        );
      },
      publicIdentifiers(config) {
        return {
          mode: config.mode,
          ...(config.clientId === undefined ? {} : { clientId: config.clientId }),
        };
      },
      acceptsEvents(config) {
        return config.webhookSecret !== undefined || config.mode === "direct";
      },
      async verifyDirect(config) {
        if (config.mode === "oauth") return undefined;
        return {
          identity: { provider: "acme" as const, id: "acme-app-1", name: "Acme Direct App" },
          initialConnection: {
            externalId: "acme-ws-direct",
            displayName: "Acme Direct Workspace",
            providerApplicationId: "acme-app-1",
            scopes: ["cards:read", "comments:write"],
            credentials: { accessToken: config.token ?? "direct-secret" },
            metadata: { tier: "direct" },
          },
        };
      },
      oauthAppIdentity(config) {
        return {
          provider: "acme" as const,
          id: config.clientId ?? "acme-oauth-app",
          name: "Acme OAuth App",
        };
      },
      setupActions: {
        ping: async (context) => ({
          ok: true,
          provider: "acme",
          hasConfig: context.configuration !== undefined,
          echo: typeof context.payload === "string" ? context.payload : "pong",
        }),
      },
      connectionStatus(records) {
        if (records.length === 0) return { status: "disconnected" };
        if (records.some((record) => record.status === "requires_reauthorization")) {
          return { status: "requiresReauthorization" };
        }
        if (records.some((record) => record.status === "suspended")) {
          return { status: "suspended" };
        }
        return { status: "connected" };
      },
      projectConnection(record) {
        const view = toPublicConnectionView(record);
        let status: "connected" | "suspended" | "requiresReauthorization" = "connected";
        if (view.status === "suspended") status = "suspended";
        else if (view.status === "requires_reauthorization") status = "requiresReauthorization";
        return {
          id: view.id,
          provider: view.provider,
          slug: view.slug,
          externalId: view.externalId,
          displayName: view.displayName,
          status,
          scopes: view.scopes,
          workspaceId: view.workspaceId,
          metadata: view.metadata,
        };
      },
      createRuntime(config, context) {
        return {
          async beginConnection(request, access) {
            const url = new URL(request.url);
            const state = `state-${randomUUID()}`;
            const stateVerifier = createHash("sha256").update(state).digest("hex");
            const startAccess =
              access ??
              (await (async () => {
                const account = await context.auth.resolveAccount(request);
                return {
                  organizationId: url.searchParams.get("organizationId") ?? "org-1",
                  membershipId: url.searchParams.get("membershipId") ?? "member-1",
                  userId: account.account.id,
                  sessionId: account.session.id,
                  returnRoute: "/apps",
                };
              })());
            await context.database.startConnectionAttempt({
              provider: "acme",
              stateVerifier,
              pkceVerifier: "pkce-verifier-acme",
              access: startAccess,
              lifetimeMinutes: 10,
              configurationVersion: context.configurationVersion,
              providerApplicationId: context.identity.id,
              callbackOrigin: context.callbackOrigin,
              configurationSnapshot: config,
              expectedConfigurationVersion:
                context.activation?.expectedConfigurationVersion ?? null,
              activateConfiguration: context.activation?.activateConfiguration ?? false,
            });
            return {
              url: `https://acme.example/oauth/authorize?client_id=${encodeURIComponent(config.clientId ?? "acme-oauth")}&state=${encodeURIComponent(state)}`,
            };
          },
          actions: {
            callback: async (request) => {
              const url = new URL(request.url);
              const state = url.searchParams.get("state");
              const code = url.searchParams.get("code");
              if (state === null || code === null) {
                return Response.json({ error: "invalid_callback" }, { status: 400 });
              }
              const account = await context.auth.resolveAccount(request);
              const attempt = {
                phase: "acme_authorization",
                stateVerifier: createHash("sha256").update(state).digest("hex"),
                access: { sessionId: account.session.id, userId: account.account.id },
              };
              const connection = {
                externalId: `acme-ws-${code}`,
                displayName: `Acme OAuth ${code}`,
                providerApplicationId: context.identity.id,
                scopes: ["cards:read", "comments:write"],
                credentials: {
                  accessToken: `oauth-access-${code}`,
                  refreshToken: `refresh-${code}`,
                },
                metadata: { mode: "oauth" },
              };
              if (
                context.activation?.activateConfiguration &&
                context.onOAuthInstallation !== undefined
              ) {
                await context.onOAuthInstallation({
                  provider: "acme",
                  configuration: config,
                  identity: context.identity,
                  expectedConfigurationVersion: context.activation.expectedConfigurationVersion,
                  callbackOrigin: context.callbackOrigin,
                  userId: account.account.id,
                  attempt,
                  connection,
                });
              } else {
                await context.database.integrations.bind({
                  attempt,
                  provider: "acme",
                  ...connection,
                });
              }
              return Response.json({ status: "connected", code }, { status: 200 });
            },
          },
        };
      },
    },
    triggers: {
      events: [ACME_CARD_EVENT],
      filterSchema: ACME_FILTER_SCHEMA,
      validateEventFilters(_event, filters, ctx) {
        if (filters.board === "forbidden-board") {
          ctx.addIssue({
            code: "custom",
            path: ["board"],
            message: "Board forbidden-board is reserved.",
          });
        }
      },
      async resolveResource(input) {
        return typeof input.filters.board === "string" ? input.filters.board : null;
      },
      createRuntime(_config, context) {
        return {
          requests: [
            {
              name: "acme.events",
              handle: async (request) => {
                const body = ACME_WEBHOOK_BODY_SCHEMA.parse(await request.json());
                const actor: EventActor = {
                  id: body.actor.id,
                  isBot: body.actor.isBot,
                  isSelfApp: body.actor.isSelfApp,
                  ...(body.actor.login === undefined ? {} : { login: body.actor.login }),
                };
                const accepted = await context.database.integrations.acceptEvent({
                  provider: "acme",
                  externalId: body.externalId,
                  deliveryId: body.deliveryId,
                  source: "acme.card_created",
                  resourceId: body.board,
                  payload: body,
                  receivedAt: context.now(),
                });
                if (accepted.status === "duplicate") {
                  return Response.json({ status: "duplicate" }, { status: 200 });
                }
                if (accepted.status === "dropped") {
                  return Response.json(
                    { status: "dropped", reason: accepted.reason },
                    { status: 202 },
                  );
                }
                const firstEvent = accepted.events[0];
                if (firstEvent === undefined) {
                  return Response.json(
                    { status: "dropped", reason: "no_project_route" },
                    { status: 202 },
                  );
                }
                const enqueued = await context.ingest.enqueue({
                  provider: "acme",
                  kind: "acme.card_created",
                  deliveryId: body.deliveryId,
                  receivedAt: context.now(),
                  connectionId: firstEvent.connectionId ?? null,
                  actor,
                  payload: {
                    receiptId: firstEvent.providerEventReceiptId,
                    organizationId: firstEvent.organizationId,
                    projectId: firstEvent.projectId,
                    configurationRevisionId: firstEvent.configurationRevisionId,
                    cardId: body.cardId,
                    board: body.board,
                  },
                });
                return Response.json(enqueued, { status: 200 });
              },
            },
            {
              name: "acme.interactions",
              handle: async () => Response.json({ handled: "interactions" }, { status: 200 }),
            },
          ],
          ingest: {
            "acme.card_created": async (event, dispatch) => {
              if (event.actor !== undefined) hooks.actorsSeen.push(event.actor);
              const payload = ACME_INGEST_PAYLOAD_SCHEMA.parse(event.payload);
              await dispatch({
                organizationId: payload.organizationId,
                projectId: payload.projectId,
                configurationRevisionId: payload.configurationRevisionId,
                providerEventReceiptId: payload.receiptId,
                deliveryId: event.deliveryId,
                source: "acme.card_created",
                receivedAt: event.receivedAt,
                connectionId: event.connectionId ?? null,
                resourceId: payload.board,
                payload: {
                  cardId: payload.cardId,
                  board: payload.board,
                  actor: event.actor ?? null,
                },
              });
            },
          },
          triggerProvider: (resources) => ({
            name: "acme",
            eventNames: ["acme.card_created"] as const,
            async match(external) {
              const configStore = resources.configurationStoreForProject(external.projectId);
              const active = await configStore.getActive();
              if (active === undefined) return "configuration_unavailable";
              const payload = ACME_TRIGGER_PAYLOAD_SCHEMA.parse(external.payload);
              const actor: EventActor | null =
                payload.actor === null
                  ? null
                  : {
                      id: payload.actor.id,
                      isBot: payload.actor.isBot,
                      isSelfApp: payload.actor.isSelfApp,
                      ...(payload.actor.login === undefined ? {} : { login: payload.actor.login }),
                    };
              const matches = [];
              for (const trigger of active.configuration.triggers) {
                if (trigger.on !== "acme.card_created") continue;
                if (
                  trigger.filters?.["board"] !== undefined &&
                  trigger.filters["board"] !== payload.board
                ) {
                  continue;
                }
                const allowed = trigger.filters?.from_users;
                if (allowed !== undefined && !allowed.includes(actor?.id ?? "unknown")) continue;
                matches.push({
                  triggerName: trigger.name,
                  triggerContext: { cardId: payload.cardId, board: payload.board },
                  outputContext: { cardId: payload.cardId },
                  hubConfig: active.configuration,
                  conversation: null,
                  invocation: { status: "accepted" as const, prompt: "Triage", inputs: {} },
                  ...(actor === null ? {} : { actor }),
                  provenance: {
                    provider: "acme",
                    externalObjectId: payload.cardId,
                  },
                });
              }
              return matches.length === 0 ? "trigger_filters_rejected" : matches;
            },
          }),
          outputs: [
            {
              type: "acme.reply",
              tool: replyOutputTool,
              available: (outputContext) =>
                ACME_OUTPUT_CONTEXT_SCHEMA.safeParse(outputContext).success,
              execute: async (input) => {
                const { cardId } = ACME_OUTPUT_CONTEXT_SCHEMA.parse(input.outputContext);
                const { body } = ACME_REPLY_ARGS_SCHEMA.parse(input.args);
                hooks.replies.push({ cardId, body });
                return { externalObjectId: cardId };
              },
            },
          ],
        };
      },
    },
    tools: {
      grantSchema: ACME_GRANT_SCHEMA,
      normalizeGrant(grant) {
        return {
          connection: grant.connection,
          actions: [...new Set(grant.actions)].toSorted(),
          boards: [...new Set(grant.boards)].toSorted(),
        };
      },
      tools: [
        {
          action: "comment",
          schema: z.strictObject({
            card_id: z.string().min(1),
            body: z.string().min(1),
          }),
          definition: {
            name: "acme.comment_create",
            description: "Post a comment on an Acme card.",
            inputSchema: {
              type: "object",
              properties: {
                card_id: { type: "string" },
                body: { type: "string" },
              },
              required: ["card_id", "body"],
            },
          },
        },
      ],
      outboundLinkActions: ["comment"],
      linkFormatHint: (url) => `In Acme comments, format the link as [Session](${url}).`,
      createHandler: () => async (call) => {
        hooks.toolCalls.push({
          name: call.name,
          connection: call.grant.connection,
          args: call.args,
        });
        return { commentId: "c-100", cardId: call.args["card_id"] };
      },
    },
    auth: {
      async revoke(token) {
        hooks.revokedTokens.push(token);
      },
    },
  });
}

function createAcmeBrowserIntegration(): BrowserIntegrationDefinition {
  return defineBrowserIntegration({
    id: "acme",
    label: "Acme",
    resourceNoun: "Board",
    glyph: () => null,
    setup: {
      defaultVariantId: "direct",
      variants: [
        {
          id: "direct",
          label: "Direct token",
          guide: {
            provider: "acme",
            name: "Acme",
            summary: "Connect Acme with a workspace token",
            portal: { label: "Acme portal", href: "https://acme.example/apps" },
            urls: [],
            formTitle: "Acme credentials",
            summaryLabels: { identity: "Acme app", connections: "Connected workspaces" },
            environmentVariables: ["ACME_TOKEN"],
            savingContinues: false,
            actions: { save: "Verify and save", savePending: "Verifying..." },
            requiresHttps: false,
            httpsRequirement: (origin) => `HTTPS required for ${origin}`,
            receivesEvents: true,
            groups: [
              {
                id: "credentials",
                title: "Credentials",
                steps: [],
                fields: [
                  {
                    name: "token",
                    label: "API token",
                    kind: "secret",
                    required: "API token is required",
                  },
                ],
              },
            ],
          },
          buildConfiguration: (values, expectedVersion) => ({
            provider: "acme",
            mode: "direct",
            token: values["token"] ?? "",
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
          }),
        },
      ],
    },
    triggers: {
      events: [ACME_CARD_EVENT],
      filterSchema: ACME_FILTER_SCHEMA,
      validateEventFilters(_event, filters, ctx) {
        if (filters.board === "forbidden-board") {
          ctx.addIssue({
            code: "custom",
            path: ["board"],
            message: "Board forbidden-board is reserved.",
          });
        }
      },
    },
    tools: {
      grantSchema: ACME_GRANT_SCHEMA,
      normalizeGrant(grant) {
        return {
          connection: grant.connection,
          actions: [...new Set(grant.actions)].toSorted(),
          boards: [...new Set(grant.boards)].toSorted(),
        };
      },
      actions: [
        { id: "read", label: "Read cards" },
        { id: "comment", label: "Post comments" },
      ],
      fields: [
        {
          key: "boards",
          label: "Boards",
          placeholder: "board-42",
        },
      ],
      fromGrant(grant) {
        const parsed = ACME_DRAFT_GRANT_SCHEMA.safeParse(grant);
        const record = parsed.success ? parsed.data : {};
        return {
          enabled: true,
          connection: record.connection ?? "",
          actions: record.actions ?? [],
          fields: { boards: (record.boards ?? []).join(", ") },
        };
      },
      toGrant(draft) {
        const boards = (draft.fields["boards"] ?? "")
          .split(",")
          .map((item: string) => item.trim())
          .filter((item: string) => item.length > 0);
        return {
          connection: draft.connection,
          actions: draft.actions,
          boards,
        };
      },
      validateDraft(draft) {
        const messages: string[] = [];
        if (draft.connection.trim().length === 0) messages.push("Choose an Acme connection");
        if (draft.actions.length === 0) messages.push("Select at least one Acme action");
        return messages;
      },
    },
  });
}

async function collectTransitiveLocalImports(entryFiles: readonly string[]): Promise<{
  readonly files: ReadonlySet<string>;
  readonly specifiers: readonly { readonly from: string; readonly specifier: string }[];
}> {
  const root = process.cwd();
  const visited = new Set<string>();
  const specifiers: { from: string; specifier: string }[] = [];
  const queue = entryFiles.map((file) => resolvePath(root, file));
  const importPattern = /(?:import|export)\s+(?!type\b)(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const rel = relative(root, current);
    if (visited.has(rel)) continue;
    visited.add(rel);
    const source = await readFile(current, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      specifiers.push({ from: rel, specifier });
      if (!specifier.startsWith(".")) continue;
      const base = resolvePath(dirname(current), specifier.replace(/\.js$/u, ""));
      const candidates = [
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
      ];
      const next = candidates.find((candidate) => existsSync(candidate));
      if (next !== undefined && !visited.has(relative(root, next))) {
        const nextRel = relative(root, next);
        // TanStack Start compiles createServerFn modules into RPC stubs in the client bundle.
        if (nextRel.endsWith("/functions.ts")) continue;
        queue.push(next);
      }
    }
  }
  return { files: visited, specifiers };
}

describe("integrations contract & strangler seam", () => {
  it("enforces strict transitive browser/server isolation and alignment across production registries", async () => {
    assertIntegrationRegistriesAligned(
      defaultIntegrationRegistry,
      defaultBrowserIntegrationRegistry,
    );
    assert.equal(defaultIntegrationRegistry.has("notion"), true);
    assert.equal(defaultBrowserIntegrationRegistry.has("notion"), true);

    const browserEntries = [
      "src/integrations/browser-contracts.ts",
      "src/integrations/browser-registry.ts",
      "src/integrations/browser.ts",
      "src/integration-tools/grants.ts",
      "src/triggers/configuration/schema.ts",
      "src/triggers/configuration/editor.ts",
      "src/triggers/integration-access.tsx",
      "src/triggers/panel.tsx",
    ];
    const graph = await collectTransitiveLocalImports(browserEntries);

    for (const file of graph.files) {
      assert.equal(
        file,
        file === "src/integrations/server.ts" || file === "src/integrations/registry.ts"
          ? "FORBIDDEN"
          : file,
        `Browser entry graph must not reach server integration module ${file}`,
      );
      assert.equal(
        file.startsWith("src/db/"),
        false,
        `Browser entry graph must not reach database module ${file}`,
      );
      assert.equal(
        file.startsWith("src/server/"),
        false,
        `Browser entry graph must not reach server module ${file}`,
      );
    }
    for (const edge of graph.specifiers) {
      assert.equal(
        edge.specifier.startsWith("node:") ||
          edge.specifier === "pg" ||
          edge.specifier === "drizzle-orm",
        false,
        `Browser entry ${edge.from} must not import server/Node module "${edge.specifier}"`,
      );
    }
  });

  it("validates integration IDs, reserved legacy IDs, event prefixes, and duplicate tool names", () => {
    const hooks: AcmeTestHooks = { replies: [], toolCalls: [], revokedTokens: [], actorsSeen: [] };
    const acme = createAcmeServerIntegration(hooks);

    assert.throws(
      () => createIntegrationRegistry([{ ...acme, id: "Acme" }]),
      /invalid integration id/iu,
    );
    assert.throws(() => createIntegrationRegistry([{ ...acme, id: "github" }]), /reserved/iu);
    assert.throws(() => createIntegrationRegistry([acme, acme]), /duplicate integration id/iu);
    assert.throws(
      () =>
        createIntegrationRegistry([
          {
            ...acme,
            triggers: {
              ...acme.triggers!,
              events: [{ id: "other.event", label: "Wrong prefix" }],
            },
          },
        ]),
      /must use "acme\.<occurrence>" format/iu,
    );
    assert.throws(
      () =>
        createIntegrationRegistry([
          acme,
          {
            ...acme,
            id: "beta",
            triggers: {
              ...acme.triggers!,
              events: [{ id: "beta.card_created", label: "Beta card" }],
            },
          },
        ]),
      /duplicate integration tool name/iu,
    );

    const browserAcme = createAcmeBrowserIntegration();
    assert.throws(
      () => createBrowserIntegrationRegistry([{ ...browserAcme, id: "slack" }]),
      /reserved/iu,
    );
    assert.throws(
      () => createBrowserIntegrationRegistry([browserAcme, browserAcme]),
      /duplicate browser integration id/iu,
    );

    // Server and browser registries must agree on IDs, trigger events, and shared Zod schemas.
    assertIntegrationRegistriesAligned(
      createIntegrationRegistry([acme]),
      createBrowserIntegrationRegistry([browserAcme]),
    );
    assert.throws(
      () =>
        assertIntegrationRegistriesAligned(
          createIntegrationRegistry([acme]),
          createBrowserIntegrationRegistry([]),
        ),
      /missing from the browser registry/iu,
    );
    assert.throws(
      () =>
        assertIntegrationRegistriesAligned(
          createIntegrationRegistry([acme]),
          createBrowserIntegrationRegistry([
            {
              ...browserAcme,
              triggers: {
                ...browserAcme.triggers!,
                filterSchema: z.object({ board: z.string().min(1).optional() }),
              },
            },
          ]),
        ),
      /share the same filterSchema/iu,
    );
    assert.throws(
      () =>
        assertIntegrationRegistriesAligned(
          createIntegrationRegistry([acme]),
          createBrowserIntegrationRegistry([
            {
              ...browserAcme,
              tools: {
                ...browserAcme.tools!,
                grantSchema: z.strictObject({
                  connection: z.string().min(1),
                  actions: z.array(z.string()).min(1),
                }),
              },
            },
          ]),
        ),
      /share the same grantSchema/iu,
    );
  });

  it("proves connection persistence, refresh lock serialization, credential stripping, and disconnect cleanup on MemoryDatabase", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org-1", "org-2"] });
    const bound = await database.integrations.bind({
      organizationId: "org-1",
      connectedByUserId: "user-1",
      provider: "acme",
      providerApplicationId: "acme-app-1",
      externalId: "ws-1",
      displayName: "Acme Primary",
      scopes: ["cards:read"],
      credentials: { accessToken: "secret-v1", refreshToken: "refresh-v1" },
      metadata: { region: "eu" },
    });
    assert.equal(bound.provider, "acme");
    assert.equal(bound.slug, "acme-primary-acme");

    // Public view strips credentials at the boundary.
    const publicView = toPublicConnectionView(bound);
    assert.equal("credentials" in publicView, false);
    assert.equal(publicView.slug, "acme-primary-acme");

    // Cross-organization collision raises ConnectionConflictError.
    await assert.rejects(
      database.integrations.bind({
        organizationId: "org-2",
        connectedByUserId: "user-2",
        provider: "acme",
        providerApplicationId: "acme-app-1",
        externalId: "ws-1",
        displayName: "Acme Stolen",
        credentials: { accessToken: "stolen" },
      }),
      ConnectionConflictError,
    );

    // withRefreshLock serializes concurrent token refreshes so the second sees updated credentials.
    const observedTokens: string[] = [];
    await Promise.all([
      database.integrations.withRefreshLock(bound.id, async (current, update) => {
        assert.ok(current);
        observedTokens.push(String(current.credentials["accessToken"]));
        await new Promise((resolve) => setTimeout(resolve, 25));
        await update({ credentials: { accessToken: "secret-v2", refreshToken: "refresh-v2" } });
        return "first";
      }),
      database.integrations.withRefreshLock(bound.id, async (current) => {
        assert.ok(current);
        observedTokens.push(String(current.credentials["accessToken"]));
        return "second";
      }),
    ]);
    assert.deepEqual(observedTokens, ["secret-v1", "secret-v2"]);

    // Event acceptance drops with no_project_route until a route exists, then accepts & deduplicates.
    const unrouted = await database.integrations.acceptEvent({
      provider: "acme",
      externalId: "ws-1",
      deliveryId: "del-unrouted",
      source: "acme.card_created",
      payload: { ok: true },
      receivedAt: new Date("2026-08-01T09:59:00Z"),
    });
    assert.equal(unrouted.status, "dropped");
    if (unrouted.status === "dropped") {
      assert.equal(unrouted.reason, "no_project_route");
    }

    const project = await database.createProject({
      organizationId: "org-1",
      name: "Acme Route Project",
      slug: "acme-route-project",
      createdByUserId: "user-1",
    });
    const rev = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "hash-acme-route",
    });
    await database.activateProjectConfigurationRevision(project.id, rev.id, [
      {
        provider: "acme",
        connectionId: bound.id,
        resourceId: null,
        triggerName: "acme-triage",
      },
    ]);

    const first = await database.integrations.acceptEvent({
      provider: "acme",
      externalId: "ws-1",
      deliveryId: "del-1",
      source: "acme.card_created",
      payload: { ok: true },
      receivedAt: new Date("2026-08-01T10:00:00Z"),
    });
    assert.equal(first.status, "accepted");
    const dup = await database.integrations.acceptEvent({
      provider: "acme",
      externalId: "ws-1",
      deliveryId: "del-1",
      source: "acme.card_created",
      payload: { ok: true },
      receivedAt: new Date("2026-08-01T10:00:01Z"),
    });
    assert.equal(dup.status, "accepted");
    if (first.status === "accepted" && dup.status === "accepted") {
      assert.equal(dup.receiptId, first.receiptId);
    }

    await database.integrations.updateStatus(bound.id, "requires_reauthorization");
    const dropped = await database.integrations.acceptEvent({
      provider: "acme",
      externalId: "ws-1",
      deliveryId: "del-2",
      source: "acme.card_created",
      payload: { ok: true },
      receivedAt: new Date("2026-08-01T10:00:02Z"),
    });
    assert.equal(dropped.status, "dropped");
    if (dropped.status === "dropped") {
      assert.equal(dropped.reason, "configuration_unavailable");
    }

    // Disconnect deletes the connection cleanly.
    const disconnected = await database.integrations.disconnect("acme", bound.id, {
      organizationId: "org-1",
      membershipId: "member-1",
      userId: "user-1",
      sessionId: "sess-1",
      returnRoute: "/apps",
    });
    assert.equal(disconnected.id, bound.id);
    assert.equal(await database.integrations.findById(bound.id), undefined);
  });

  it("compiles YAML, validates strict filter schema, round-trips trigger editor, and resolves routes + tools + link hints", async () => {
    const hooks: AcmeTestHooks = { replies: [], toolCalls: [], revokedTokens: [], actorsSeen: [] };
    const acme = createAcmeServerIntegration(hooks);
    const serverRegistry = createIntegrationRegistry([acme]);
    const browserRegistry = createBrowserIntegrationRegistry([createAcmeBrowserIntegration()]);

    assert.equal(isEditorEvent("acme.card_created", browserRegistry), true);
    assert.equal(eventDefinition("acme.card_created", browserRegistry).provider, "acme");
    assert.equal(automaticReplyType("acme.card_created", browserRegistry), "acme.reply");
    assert.equal(
      connectionReturnCopy({ provider: "acme", result: "acme_connected" }, browserRegistry).message,
      "Acme connected",
    );

    // Environment parsing reads registered integrations without touching legacy keys.
    const envConfig = await readProviderApplicationEnvironment(
      { ACME_TOKEN: "env-secret-token" },
      serverRegistry,
    );
    assert.equal(envConfig.registered?.["acme"]?.["token"], "env-secret-token");

    // 4th capability slot (`auth.revoke`) preserved through defineIntegration + registry.
    await serverRegistry.get("acme")?.auth?.revoke("temp-token-1");
    assert.deepEqual(hooks.revokedTokens, ["temp-token-1"]);

    // YAML compilation: valid acme trigger with board qualifier + run.tools.acme grant.
    const yaml = createTriggerYaml(
      {
        name: "acme-triage",
        enabled: true,
        event: "acme.card_created",
        connection: "acme-primary-acme",
        audience: "specific",
        allowedUsers: "u-alice",
        qualifiers: { board: "board-42" },
        daemon: "build-mac",
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
          acme: {
            enabled: true,
            connection: "acme-primary-acme",
            actions: ["comment"],
            fields: { boards: "board-42" },
          },
        },
        prompt: "Triage the card.",
      },
      browserRegistry,
    );

    // Schema builders cache built Zod schemas per registry instance.
    assert.equal(
      buildTriggerDocumentSchema(serverRegistry),
      buildTriggerDocumentSchema(serverRegistry),
    );
    assert.equal(
      buildIntegrationToolGrantsSchema(serverRegistry),
      buildIntegrationToolGrantsSchema(serverRegistry),
    );
    assert.equal(
      buildCompiledIntegrationToolGrantsSchema(serverRegistry),
      buildCompiledIntegrationToolGrantsSchema(serverRegistry),
    );

    // Unknown filter keys are reported in the same pass alongside other document errors.
    const multiErrorYaml = `name: t
on:
  github.issue_comment:
    filters:
      repo: o/r
      bogus: x
run:
  target: { daemon: d, cwd: /r }
  agent: { provider: codex }
`;
    const multiErrorResult = TriggerDocumentSchema.safeParse(parseDocument(multiErrorYaml).toJS());
    assert.equal(multiErrorResult.success, false);
    if (!multiErrorResult.success) {
      const paths = new Set(multiErrorResult.error.issues.map((issue) => issue.path.join(".")));
      assert.equal(paths.has("on.github.issue_comment.filters"), true);
      assert.equal(paths.has("run.prompt"), true);
    }
    const multiErrorHubConfig = HubConfigSchema.safeParse({
      environments: [{ name: "d", kind: "daemon", daemon: "d", cwd: "/r" }],
      triggers: [
        {
          name: "t",
          on: "github.issue_comment",
          steps: [],
          filters: { repo: "o/r", bogus: "x" },
        },
      ],
    });
    assert.equal(multiErrorHubConfig.success, false);
    if (!multiErrorHubConfig.success) {
      const paths = new Set(multiErrorHubConfig.error.issues.map((issue) => issue.path.join(".")));
      assert.equal(paths.has("triggers.0.filters"), true);
      assert.equal(paths.has("triggers.0.max_runtime"), true);
    }

    const compiled = compileTriggerDocument(yaml, serverRegistry);
    assert.equal(compiled.events.length, 1);
    const compiledEvent = compiled.events[0]!;
    assert.equal(compiledEvent.on, "acme.card_created");
    assert.equal(compiledEvent.filters?.["board"], "board-42");
    assert.deepEqual(
      compiledEvent.steps[0]?.allowOutputs.map((output) => output.type),
      ["acme.reply"],
    );
    assert.deepEqual(compiledEvent.steps[0]?.tools?.["acme"], {
      connection: "acme-primary-acme",
      actions: ["comment"],
      boards: ["board-42"],
    });

    // Reject unknown filter keys and custom validateEventFilters errors.
    assert.throws(
      () =>
        compileTriggerDocument(
          yaml.replace("board: board-42", "board: board-42\n      unknown_key: bad"),
          serverRegistry,
        ),
      /Unrecognized key/u,
    );
    assert.throws(
      () =>
        compileTriggerDocument(
          yaml.replace("board: board-42", "board: forbidden-board"),
          serverRegistry,
        ),
      /forbidden-board is reserved/u,
    );

    // Editor round-trip uses only the browser registry and preserves qualifier + tool drafts.
    const projected = projectTriggerForm(yaml, browserRegistry);
    assert.equal(projected.status, "editable");
    if (projected.status !== "editable") throw new Error("expected editable");
    assert.equal(projected.value.qualifiers["board"], "board-42");
    assert.equal(projected.value.integrationTools?.["acme"]?.connection, "acme-primary-acme");
    assert.deepEqual(triggerFormErrors(projected.value, [], browserRegistry), {});
    const patched = patchTriggerYaml(
      yaml,
      { ...projected.value, qualifiers: { board: "board-99" } },
      browserRegistry,
    );
    const reparsed = compileTriggerDocument(patched, serverRegistry);
    assert.equal(reparsed.events[0]?.filters?.["board"], "board-99");
  });

  it("resolves routes, matches triggers with EventActor/provenance, executes reply + MCP tools, and injects link hints", async () => {
    const hooks: AcmeTestHooks = { replies: [], toolCalls: [], revokedTokens: [], actorsSeen: [] };
    const acme = createAcmeServerIntegration(hooks);
    const serverRegistry = createIntegrationRegistry([acme]);
    const browserRegistry = createBrowserIntegrationRegistry([createAcmeBrowserIntegration()]);
    const yaml = createTriggerYaml(
      {
        name: "acme-triage",
        enabled: true,
        event: "acme.card_created",
        connection: "acme-primary-acme",
        audience: "specific",
        allowedUsers: "u-alice",
        qualifiers: { board: "board-42" },
        daemon: "build-mac",
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
          acme: {
            enabled: true,
            connection: "acme-primary-acme",
            actions: ["comment"],
            fields: { boards: "board-42" },
          },
        },
        prompt: "Triage the card.",
      },
      browserRegistry,
    );
    const compiled = compileTriggerDocument(yaml, serverRegistry);
    const compiledEvent = compiled.events[0]!;

    // Route compilation via resolveTriggerConfigurationForOrganization resolves resource via triggers.resolveResource.
    const database = createMemoryDatabase({ organizationIds: ["org-1"] });
    const project = await database.createProject({
      organizationId: "org-1",
      name: "Demo",
      slug: "demo",
      createdByUserId: "user-1",
    });
    await database.issueEnrollmentToken({
      id: randomUUID(),
      verifier: "enroll-verifier-1",
      organizationId: "org-1",
      issuedByApiKeyId: null,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    await database.enrollDaemon({
      daemonId: randomUUID(),
      idempotencyKey: "enroll-idem-1",
      tokenVerifier: "enroll-verifier-1",
      suggestedSlug: "build-mac",
      serverId: "srv-1",
      daemonPublicKey: "pub-1",
      credentialVerifier: "cred-1",
      permissions: ["hub.execute"],
      now: new Date(),
    });
    const boundConn = await database.integrations.bind({
      organizationId: "org-1",
      connectedByUserId: "user-1",
      provider: "acme",
      providerApplicationId: "acme-app-1",
      externalId: "ws-1",
      displayName: "Acme Primary",
      credentials: { accessToken: "secret" },
    });
    const resolved = await resolveTriggerConfigurationForOrganization(
      database,
      "org-1",
      {
        environments: [compiled.environment],
        triggers: [compiledEvent],
      },
      serverRegistry,
    );
    assert.equal(resolved.success, true);
    if (!resolved.success) throw new Error("expected trigger configuration resolution to succeed");
    assert.equal(resolved.configuration.triggers[0]?.filters?.connectionId, boundConn.id);
    assert.equal(resolved.configuration.triggers[0]?.filters?.resourceId, "board-42");
    assert.deepEqual(resolved.routes, [
      {
        provider: "acme",
        connectionId: boundConn.id,
        resourceId: "board-42",
        configuredEventName: "acme.card_created",
      },
    ]);

    // Trigger provider match & acme.reply output execution!
    const saved = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: resolved.configuration,
      contentHash: "hash-contract",
    });
    await database.activateProjectConfigurationRevision(project.id, saved.id);
    const triggersRuntime = acme.triggers!.createRuntime(
      { provider: "acme", mode: "direct", token: "tok" },
      {
        database,
        auth: stubAuth(),
        callbackOrigin: "https://hub.test",
        identity: { provider: "acme", id: "acme-app-1", name: "Acme" },
        configurationVersion: 1,
        fetch,
        now: () => new Date(),
        ingest: { enqueue: async () => ({ status: "accepted" }) },
      },
    );
    const configStore = new ProjectConfigurationStore(
      database,
      project.id,
      undefined,
      serverRegistry,
    );
    const provider = triggersRuntime.triggerProvider({
      configurationStoreForProject: () => configStore,
      connectionsForProject: () => async () => "",
    });
    assert.ok(provider);
    const matchActor: EventActor = {
      id: "u-alice",
      login: "alice",
      isBot: false,
      isSelfApp: false,
    };
    const matchResult = await provider.match({
      organizationId: "org-1",
      projectId: project.id,
      configurationRevisionId: saved.id,
      providerEventReceiptId: "rec-1",
      deliveryId: "del-match",
      source: "acme.card_created",
      receivedAt: new Date(),
      payload: { cardId: "card-1", board: "board-42", actor: matchActor },
    });
    if (typeof matchResult === "string") throw new Error(`expected matches, got ${matchResult}`);
    const match = matchResult[0]!;
    assert.deepEqual(match.actor, matchActor);
    assert.deepEqual(match.provenance, { provider: "acme", externalObjectId: "card-1" });

    const outputRegistry = new OutputExecutorRegistry();
    for (const output of triggersRuntime.outputs ?? []) outputRegistry.register(output);
    const materializedOutputs = outputRegistry.materialize(
      [{ type: "acme.reply", required: false }],
      match.outputContext,
    );
    assert.equal(materializedOutputs.length, 1);
    await outputRegistry.execute({
      agentExecutionId: "exec-1",
      toolType: "acme.reply",
      outputContext: match.outputContext,
      args: { body: "Triaged!" },
    });
    assert.deepEqual(hooks.replies, [{ cardId: "card-1", body: "Triaged!" }]);

    // Scoped MCP tools + agent-sessions outbound link hint.
    const toolDefs = integrationToolDefinitions(compiledEvent.steps[0]?.tools, serverRegistry);
    assert.deepEqual(
      toolDefs.map((def) => def.name),
      ["acme.comment_create"],
    );
    const toolResult = await callIntegrationTool({
      name: "acme.comment_create",
      organizationId: "org-1",
      grants: compiledEvent.steps[0]?.tools,
      handlers: {
        registered: {
          acme: acme.tools!.createHandler(
            { provider: "acme", mode: "direct", token: "tok" },
            {
              database,
              auth: stubAuth(),
              callbackOrigin: "https://hub.test",
              identity: { provider: "acme", id: "acme-app-1", name: "Acme" },
              configurationVersion: 1,
              fetch,
              now: () => new Date(),
              ingest: { enqueue: async () => ({ status: "accepted" }) },
            },
          ),
        },
      },
      args: { card_id: "card-1", body: "Looks good" },
      registry: serverRegistry,
    });
    assert.deepEqual(toolResult?.value, { commentId: "c-100", cardId: "card-1" });
    assert.equal(hooks.toolCalls.length, 1);

    const execution = await database.insertAgentExecution({
      organizationId: "org-1",
      projectId: project.id,
      machineId: null,
      daemonId: "daemon-1",
      configurationRevisionId: saved.id,
      triggerContext: {},
      outputContext: {},
    });
    const sentPrompts: string[] = [];
    const sessions = new AgentSessions(
      database,
      "session-secret-01234567890123456789",
      "https://hub.test",
      new OutputExecutorRegistry(),
      Date.now,
      serverRegistry,
    );
    const dispatched = await sessions.dispatch({
      executionId: execution.id,
      intent: {
        kind: "launch_machine",
        organizationId: "org-1",
        projectId: project.id,
        triggerRunId: randomUUID(),
        triggerName: "acme-triage",
        environmentName: "target",
        configurationRevisionId: saved.id,
        prompt: "Review card",
        agent: { provider: "claude" },
        environment: {
          kind: "daemon",
          daemonId: "daemon-1",
          authoredSlug: "build-mac",
          cwd: "/repo",
          env: {},
        },
        env: {},
        ...(compiledEvent.steps[0]?.tools === undefined
          ? {}
          : { tools: compiledEvent.steps[0].tools }),
        allowOutputs: [],
        triggerContext: {},
        outputContext: {},
        hubConfig: resolved.configuration,
        autoArchive: true,
        background: false,
      },
      connection: {
        create: async () => ({ id: "agent-1", workspaceId: "ws-1", status: "idle" }),
        get: async () => ({ id: "agent-1", workspaceId: "ws-1", status: "idle", archivedAt: null }),
        restore: async () => true,
        watch: async () => () => {},
        send: async (_agentId, _execId, prompt) => {
          sentPrompts.push(prompt);
        },
        control: async () => {},
      },
      createOptions: async () => ({
        provider: "claude",
        cwd: "/repo",
        env: {},
      }),
      onEvent: () => {},
    });
    dispatched.unsubscribe();
    assert.equal(sentPrompts.length, 1);
    assert.match(
      sentPrompts[0]!,
      /In Acme comments, format the link as \[Session\]\(https:\/\/hub\.test\//u,
    );
  });

  it("proves end-to-end embedded Postgres persistence, SQL constraints, direct + OAuth setup, dynamic routes, ingest decoupling, Activity join, and Home/Org snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-integrations-contract-"));
    const { runtime, locks } = await embeddedDatabaseRuntime(join(root, "database"));
    await runtime.migrate();
    const database = createDatabase(runtime, locks);
    const entitlements = composeEntitlements(database, runtime);
    const auth = createAuthServer({
      database: runtime,
      locks,
      entitlements: entitlements.service,
      secret: "integrations-contract-secret".padEnd(32, "-"),
      baseURL: "https://hub.test",
      policy: {
        registrationMode: "invite_only",
        organizationCreation: "disabled",
        bootstrap: {
          ownerEmail: "owner@acme.test",
          ownerPassword: "owner-password-1234",
          organizationName: "Contract Org",
        },
      },
    });

    const hooks: AcmeTestHooks = { replies: [], toolCalls: [], revokedTokens: [], actorsSeen: [] };
    const acme = createAcmeServerIntegration(hooks);
    const serverRegistry = createIntegrationRegistry([acme]);

    let capturedInbound: IntegrationInboundEvent[] = [];
    let forwardInbound = true;

    const providerStore = createProviderApplicationStore(runtime, locks, database, serverRegistry);
    const providerInventory = createProviderApplicationInventory(runtime);
    const providerVerifier = createProviderApplicationVerifier({ registry: serverRegistry });
    const dynamicRuntime = new DynamicProviderRuntime({
      database,
      auth,
      applicationBaseUrl: "https://hub.test",
      registry: serverRegistry,
      inboundSink: {
        enqueue: async (event) => {
          capturedInbound.push(event);
          if (!forwardInbound) return { status: "accepted" };
          const handler = activeTriggerHandler;
          const acmeRuntime = acme.triggers?.createRuntime(
            { provider: "acme", mode: "direct", token: "direct-tok" },
            {
              database,
              auth,
              callbackOrigin: "https://hub.test",
              identity: { provider: "acme", id: "acme-app-1", name: "Acme" },
              configurationVersion: 1,
              fetch,
              now: () => new Date(),
              ingest: { enqueue: async () => ({ status: "accepted" }) },
            },
          );
          if (handler !== undefined && acmeRuntime?.ingest?.[event.kind] !== undefined) {
            await acmeRuntime.ingest[event.kind]!(event, handler);
          }
          return { status: "accepted" };
        },
      },
    });
    let activeTriggerHandler: TriggerHandler | undefined;

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
      assert.ok(owner);

      // Sign in first via HTTP auth endpoint to obtain a real session cookie for FK constraints and OAuth callbacks.
      const signInResponse = await auth.handle(
        new Request("https://hub.test/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://hub.test",
          },
          body: JSON.stringify({
            email: "owner@acme.test",
            password: "owner-password-1234",
          }),
        }),
      );
      assert.equal(signInResponse.status, 200);
      const initialCookie = signInResponse.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0]!)
        .join("; ");
      await auth.changePassword!(
        { currentPassword: "owner-password-1234", newPassword: "owner-password-5678" },
        new Headers({ cookie: initialCookie, origin: "https://hub.test" }),
      );
      const freshSignIn = await auth.handle(
        new Request("https://hub.test/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://hub.test",
          },
          body: JSON.stringify({
            email: "owner@acme.test",
            password: "owner-password-5678",
          }),
        }),
      );
      assert.equal(freshSignIn.status, 200);
      const cookieHeader = freshSignIn.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0]!)
        .join("; ");
      const authedRequest = (url: string, method = "GET") =>
        new Request(url, {
          method,
          headers: { cookie: cookieHeader, origin: "https://hub.test" },
        });
      const resolvedAccount = await auth.resolveAccount(authedRequest("https://hub.test/apps"));

      // Verify SQL CHECK constraints on real embedded Postgres:
      // 1) Invalid uppercase provider rejected on organization_connection_attempts.
      await assert.rejects(
        runtime.query(
          `insert into organization_connection_attempts
             (organization_id, provider, phase, state_verifier, return_route, user_id, session_id, configuration_version, callback_origin, configuration_snapshot, expires_at)
           values ($1, 'BAD_PROVIDER', 'bad_phase', 'sv-bad', '/apps', $2, $3, 1, 'https://hub.test', '{}', now() + interval '5 minutes')`,
          [owner.organization_id, owner.user_id, resolvedAccount.session.id],
        ),
      );
      // 2) GitHub 3-phase shape check preserved (github_setup with pkce_verifier set is rejected).
      await assert.rejects(
        runtime.query(
          `insert into organization_connection_attempts
             (organization_id, provider, phase, state_verifier, pkce_verifier, return_route, user_id, session_id, configuration_version, callback_origin, configuration_snapshot, expires_at)
           values ($1, 'github', 'github_setup', 'sv-gh-bad', 'illegal-pkce', '/apps', $2, $3, 1, 'https://hub.test', '{}', now() + interval '5 minutes')`,
          [owner.organization_id, owner.user_id, resolvedAccount.session.id],
        ),
      );
      // 3) Slack/Discord/Linear phase and pkce_verifier=null checks are preserved.
      await assert.rejects(
        runtime.query(
          `insert into organization_connection_attempts
             (organization_id, provider, phase, state_verifier, return_route, user_id, session_id, configuration_version, callback_origin, configuration_snapshot, expires_at)
           values ($1, 'slack', 'linear_authorization', 'sv-slack-phase', '/apps', $2, $3, 1, 'https://hub.test', '{}', now() + interval '5 minutes')`,
          [owner.organization_id, owner.user_id, resolvedAccount.session.id],
        ),
      );
      await assert.rejects(
        runtime.query(
          `insert into organization_connection_attempts
             (organization_id, provider, phase, state_verifier, pkce_verifier, return_route, user_id, session_id, configuration_version, callback_origin, configuration_snapshot, expires_at)
           values ($1, 'slack', 'slack_authorization', 'sv-slack-pkce', 'illegal-pkce', '/apps', $2, $3, 1, 'https://hub.test', '{}', now() + interval '5 minutes')`,
          [owner.organization_id, owner.user_id, resolvedAccount.session.id],
        ),
      );
      // 4) New integration phase must match `${provider}_authorization`, while PKCE is allowed.
      await assert.rejects(
        runtime.query(
          `insert into organization_connection_attempts
             (organization_id, provider, phase, state_verifier, pkce_verifier, return_route, user_id, session_id, configuration_version, callback_origin, configuration_snapshot, expires_at)
           values ($1, 'acme', 'other_authorization', 'sv-acme-bad-phase', 'pkce-ok', '/apps', $2, $3, 1, 'https://hub.test', '{}', now() + interval '5 minutes')`,
          [owner.organization_id, owner.user_id, resolvedAccount.session.id],
        ),
      );
      await runtime.query(
        `insert into organization_connection_attempts
           (organization_id, provider, phase, state_verifier, pkce_verifier, return_route, user_id, session_id, configuration_version, callback_origin, configuration_snapshot, expires_at)
         values ($1, 'acme', 'acme_authorization', 'sv-acme-pkce', 'pkce-ok', '/apps', $2, $3, 1, 'https://hub.test', '{}', now() + interval '5 minutes')`,
        [owner.organization_id, owner.user_id, resolvedAccount.session.id],
      );

      // Build operator-scoped ProviderApplications backed by real embedded Postgres.
      const fakeAccount: AccountAccessValue = {
        session: { id: resolvedAccount.session.id, activeOrganizationId: owner.organization_id },
        account: { id: owner.user_id, name: "Owner", email: "owner@acme.test" },
        isInstanceOperator: true,
      };
      const operatorAuth = {
        resolveAccount: async () => fakeAccount,
        rejectCookieMutation: () => undefined,
      };
      const providerApplications = createProviderApplications({
        auth: operatorAuth,
        store: providerStore,
        environment: {},
        runtime: dynamicRuntime,
        verifier: providerVerifier,
        inventory: providerInventory,
        callbackOrigin: () => "https://hub.test",
        registry: serverRegistry,
        database,
        beginCandidateConnection: async (request, _orgId, _returnRoute, begin) => begin(request),
      });

      const postRequest = (path = "/apps") =>
        new Request(`https://hub.test${path}`, {
          method: "POST",
          headers: { origin: "https://hub.test" },
        });

      // 1) Direct app setup: verifyDirect atomically saves app config + binds initialConnection!
      const directSave = await providerApplications.verifyAndSave(postRequest(), "acme", {
        provider: "acme",
        mode: "direct",
        token: "direct-secret-token",
      });
      assert.equal(directSave.status, "verified");
      const directConnections = await database.integrations.listForOrganization(
        owner.organization_id,
        "acme",
      );
      assert.equal(directConnections.length, 1);
      assert.equal(directConnections[0]!.externalId, "acme-ws-direct");
      assert.equal(directConnections[0]!.credentials["accessToken"], "direct-secret-token");

      // Custom setup action works through providerApplications.runSetupAction.
      const pingResult = await providerApplications.runSetupAction?.(
        postRequest(),
        "acme",
        "ping",
        "hello",
      );
      assert.deepEqual(pingResult, {
        ok: true,
        provider: "acme",
        hasConfig: true,
        echo: "hello",
      });

      // Disconnect direct connection via Hub's generic connection disconnect action (no custom disconnect handler).
      const unauthStart = await application.connectionAction(
        new Request(
          `https://hub.test/connections/start?organizationSlug=${encodeURIComponent(owner.organization_slug)}`,
          { method: "POST", headers: { origin: "https://hub.test" } },
        ),
        "acme",
        "start",
      );
      assert.equal(unauthStart.status, 403);

      const disconnectResponse = await application.connectionAction(
        authedRequest(
          `https://hub.test/connections/disconnect?organizationSlug=${encodeURIComponent(owner.organization_slug)}&connectionId=${encodeURIComponent(directConnections[0]!.id)}`,
          "POST",
        ),
        "acme",
        "disconnect",
      );
      assert.equal(disconnectResponse.status, 200);
      assert.deepEqual(await disconnectResponse.json(), { disconnected: true });
      assert.equal(await database.integrations.findById(directConnections[0]!.id), undefined);

      // 2) OAuth app setup: savingContinues -> beginConnection -> GET callback -> atomic save + bind.
      const oauthSave = await providerApplications.verifyAndSave(
        authedRequest(
          `https://hub.test/apps?organizationSlug=${encodeURIComponent(owner.organization_slug)}&returnRoute=%2Fapps`,
          "POST",
        ),
        "acme",
        {
          provider: "acme",
          mode: "oauth",
          clientId: "acme-oauth-client",
          clientSecret: "acme-oauth-secret",
          expectedVersion: 1,
        },
      );
      assert.equal(oauthSave.status, "continuing");
      if (oauthSave.status !== "continuing") throw new Error("expected oauth continuation");
      const state = new URL(oauthSave.url).searchParams.get("state");
      assert.ok(state);

      // Dispatch GET /api/integrations/acme/callback through application.connectionAction.
      const callbackResponse = await application.connectionAction(
        authedRequest(
          `https://hub.test/api/integrations/acme/callback?state=${encodeURIComponent(state)}&code=42`,
        ),
        "acme",
        "callback",
      );
      assert.equal(callbackResponse.status, 200);

      const oauthConnections = await database.integrations.listForOrganization(
        owner.organization_id,
        "acme",
      );
      assert.equal(oauthConnections.length, 1);
      assert.equal(oauthConnections[0]!.externalId, "acme-ws-42");

      // Register an organization trigger route for board-42 so acme.events deliveries are accepted.
      await database.saveOrganizationTrigger({
        organizationId: owner.organization_id,
        name: "acme-route-test",
        enabled: true,
        format: "single_run",
        yaml: "name: acme-route-test\n",
        normalizedConfiguration: {
          environments: [{ name: "target", kind: "daemon", daemon: "build-mac", cwd: "/repo" }],
          triggers: [],
        },
        contentHash: "hash-1",
        sourceKind: "manual",
        sourceEvidence: { kind: "test" },
        createdByUserId: owner.user_id,
        routes: [
          {
            provider: "acme",
            connectionId: oauthConnections[0]!.id,
            resourceId: "board-42",
            configuredEventName: "acme.card_created",
          },
        ],
      });

      // 3) POST /api/integrations/acme/events exercises decoupled ingest sink + EventActor + Activity unmatched join.
      const dispatchedEvents: unknown[] = [];
      activeTriggerHandler = async (event) => {
        dispatchedEvents.push(event);
      };
      const actor: EventActor = {
        id: "u-alice",
        login: "alice",
        isBot: false,
        isSelfApp: false,
      };
      const eventResponse = await application.providerRequest(
        "acme.events",
        new Request("https://hub.test/api/integrations/acme/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deliveryId: "acme-delivery-1",
            externalId: "acme-ws-42",
            cardId: "card-77",
            board: "board-42",
            actor,
          }),
        }),
      );
      assert.equal(eventResponse.status, 200);
      assert.equal(capturedInbound.length, 1);
      assert.deepEqual(capturedInbound[0]?.actor, actor);
      assert.deepEqual(hooks.actorsSeen, [actor]);
      assert.equal(dispatchedEvents.length, 1);

      // Custom request endpoints (e.g. POST /api/integrations/acme/interactions) route cleanly,
      // while undeclared request names return 404 (never falling back to requests[0]).
      const interactionsResponse = await application.providerRequest(
        "acme.interactions",
        new Request("https://hub.test/api/integrations/acme/interactions", { method: "POST" }),
      );
      assert.equal(interactionsResponse.status, 200);
      assert.deepEqual(await interactionsResponse.json(), { handled: "interactions" });
      const unknownRequestResponse = await application.providerRequest(
        "acme.unknown",
        new Request("https://hub.test/api/integrations/acme/unknown", { method: "POST" }),
      );
      assert.equal(unknownRequestResponse.status, 404);

      // Verify decoupling: when custom inboundSink buffers without forwarding, transport still succeeds cleanly.
      forwardInbound = false;
      capturedInbound = [];
      const bufferedResponse = await application.providerRequest(
        "acme.events",
        new Request("https://hub.test/api/integrations/acme/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deliveryId: "acme-delivery-2",
            externalId: "acme-ws-42",
            cardId: "card-78",
            board: "board-42",
            actor,
          }),
        }),
      );
      assert.equal(bufferedResponse.status, 200);
      assert.equal(capturedInbound.length, 1);
      assert.equal(dispatchedEvents.length, 1);

      // 4) Activity findUnmatched resolves connectionSlug via LEFT JOIN integration_connections on real Postgres!
      const unmatchedReceipt = await database.integrations.acceptEvent({
        provider: "acme",
        externalId: "acme-ws-42",
        deliveryId: "acme-delivery-unmatched",
        source: "acme.card_created",
        resourceId: "board-42",
        payload: { cardId: "card-unmatched" },
        receivedAt: new Date(),
        dropReason: "no_project_route",
      });
      assert.equal(unmatchedReceipt.status, "dropped");
      const receiptRow = await runtime.query<{ id: string }>(
        `select id from provider_event_receipts where delivery_id = 'acme-delivery-unmatched'`,
      );
      const unmatched = await database.activity.findUnmatched(
        owner.organization_id,
        receiptRow.rows[0]!.id,
      );
      assert.ok(unmatched);
      assert.equal(unmatched.provider, "acme");
      assert.equal(unmatched.connectionSlug, oauthConnections[0]!.slug);

      // 5) HomeDashboard.snapshot & ProjectDashboard.organizationSnapshot project acme with zero credential leakage!
      const projectDashboard = new ProjectDashboard(
        database,
        auth,
        () => new Date(),
        serverRegistry,
      );
      const orgSnapshot = await projectDashboard.organizationSnapshot(
        authedRequest(`https://hub.test/o/${owner.organization_slug}/integrations`),
        { organizationSlug: owner.organization_slug },
      );
      assert.equal(orgSnapshot.connections.integrations.length, 1);
      assert.equal(orgSnapshot.connections.integrations[0]!.provider, "acme");
      assert.equal(JSON.stringify(orgSnapshot).includes("oauth-access-42"), false);

      const homeDashboard = new HomeDashboard(
        database,
        auth,
        () => true,
        () => new Date(),
        serverRegistry,
      );
      const home = await homeDashboard.snapshot(
        authedRequest(`https://hub.test/o/${owner.organization_slug}`),
        owner.organization_slug,
        "7d",
      );
      assert.equal(
        home.connections.some((connection) => connection.provider === "acme"),
        true,
      );
      assert.equal(JSON.stringify(home).includes("oauth-access-42"), false);

      // 6) Disconnect deletes associated project_trigger_routes + organization_trigger_routes + connection atomically!
      const removed = await database.integrations.disconnect("acme", oauthConnections[0]!.id, {
        organizationId: owner.organization_id,
        membershipId: owner.membership_id,
        userId: owner.user_id,
        sessionId: resolvedAccount.session.id,
        returnRoute: "/apps",
      });
      assert.equal(removed.id, oauthConnections[0]!.id);
      const remainingRoutes = await runtime.query<{ count: number }>(
        `select count(*)::int as count from organization_trigger_routes where connection_id = $1`,
        [oauthConnections[0]!.id],
      );
      assert.equal(remainingRoutes.rows[0]!.count, 0);
    } finally {
      await application.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
