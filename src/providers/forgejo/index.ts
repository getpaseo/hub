import type { AuthServer } from "../../auth/server.js";
import type { Database } from "../../db/types.js";

import { replyOutputTool } from "../../execution-capabilities/outputs.js";
import {
  createForgejoReactionClient,
  createForgejoTriggerProvider,
} from "../../triggers/forgejo/provider.js";
import { createForgejoReplyExecutor, forgejoReplyAvailable } from "../../triggers/forgejo/reply.js";
import { createForgejoWebhookSource } from "../../triggers/forgejo/webhook.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";
import {
  createForgejoApiClient,
  type ForgejoApiClient,
  type ForgejoCredentials,
} from "./client.js";
import { createForgejoConnection, forgejoStatus } from "./connection.js";
import type { ForgejoAllowedPrivateHosts } from "./instance-guard.js";

export interface CreateForgejoRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  apiClient?: ForgejoApiClient;
  fetch?: typeof fetch;
  // read once at startup, see src/index.ts. falls back to the guarded client's own env
  // read when omitted, which is what every test without this option gets
  allowedPrivateHosts?: ForgejoAllowedPrivateHosts;
}

// forgejo and gitea, connected per instance. no application to register and no
// redirect, an operator pastes a token and hub verifies it by asking the instance who
// it belongs to. no githubAuthority either: a forgejo token can't be leased or revoked
// on our side, so it only reaches a workflow through integration.resolve.
export function createForgejoRegistration(
  options: CreateForgejoRegistrationOptions,
): ProviderRegistration {
  const database = options.database;
  const api =
    options.apiClient ??
    createForgejoApiClient({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.allowedPrivateHosts === undefined
        ? {}
        : { allowedPrivateHosts: options.allowedPrivateHosts }),
    });

  if (database === null) {
    return {
      connection: forgejoConnectionStatus(undefined),
      triggerProviders: [],
      sources: [],
      outputs: [],
      requests: [],
    };
  }

  const credentialsForConnection = async (connectionId: string): Promise<ForgejoCredentials> => {
    const connection = await database.findForgejoConnection(connectionId);
    if (connection === undefined) {
      throw new Error(`forgejo connection is unavailable: ${connectionId}`);
    }
    return { instanceBaseUrl: connection.instanceBaseUrl, accessToken: connection.accessToken };
  };

  const webhook = createForgejoWebhookSource({
    findConnection: async (connectionId) => {
      const connection = await database.findForgejoConnection(connectionId);
      if (connection === undefined) return undefined;
      const siblingAccountIds = await database.listForgejoSiblingAccountIds({
        organizationId: connection.organizationId,
        instanceBaseUrl: connection.instanceBaseUrl,
        excludeConnectionId: connection.id,
      });
      return {
        id: connection.id,
        webhookSecret: connection.webhookSecret,
        accountId: connection.accountId,
        siblingAccountIds,
        credentials: {
          instanceBaseUrl: connection.instanceBaseUrl,
          accessToken: connection.accessToken,
        },
      };
    },
    accept: (input) => database.acceptForgejoEvent(input),
    completeEnrichment: (receiptId, payload) =>
      database.completeForgejoEnrichment(receiptId, payload),
    credentialsForConnection,
    timelineClient: api,
    reviewClient: api,
    claimTimelineEntries: (connectionId, timelineEntryIds, receiptId) =>
      database.claimForgejoTimelineEntries(connectionId, timelineEntryIds, receiptId),
  });

  return {
    connection:
      options.auth === null
        ? forgejoConnectionStatus(api)
        : createForgejoConnection({
            database,
            auth: options.auth,
            api,
            applicationBaseUrl: options.applicationBaseUrl,
          }),
    integration: {
      async resolve(projectId, connectionSlug, value) {
        if (value !== "token" && value !== "url" && value !== "login") {
          throw new Error(`unsupported forgejo integration value: ${value}`);
        }
        const project = await database.findProjectById(projectId);
        const selected =
          project === undefined
            ? undefined
            : (await database.organizationConnectionUsage(project.organizationId)).forgejo.find(
                (candidate) =>
                  candidate.organizationId === project.organizationId &&
                  candidate.slug === connectionSlug,
              );
        if (selected === undefined) {
          throw new Error(`forgejo connection is unavailable: ${connectionSlug}`);
        }
        if (value === "url") return selected.instanceBaseUrl;
        if (value === "login") return selected.accountLogin;
        // no registerToken: this token is long lived and can't be revoked on our side,
        // so leasing it would promise a cleanup nothing performs. scoped oauth2 tokens
        // would let us hand out short-lived ones like github installation tokens:
        // https://codeberg.org/forgejo/forgejo/issues/4052
        return selected.accessToken;
      },
    },
    triggerProviders: [
      ({ configurationStoreForProject }) =>
        createForgejoTriggerProvider({
          configurationStoreForProject,
          reactions: createForgejoReactionClient({ api, credentialsForConnection }),
        }),
    ],
    sources: [webhook],
    outputs: [
      {
        type: "forgejo.reply",
        tool: replyOutputTool,
        available: forgejoReplyAvailable,
        execute: createForgejoReplyExecutor({ client: api, credentialsForConnection }),
      },
    ],
    requests: [{ name: "forgejo.events", handle: (request) => webhook.handle(request) }],
  };
}

function forgejoConnectionStatus(
  api: ForgejoApiClient | undefined,
): ProviderConnectionRegistration {
  return {
    name: "forgejo",
    status: (connections) => forgejoStatus(api !== undefined, connections.forgejo),
    actions: {},
  };
}
