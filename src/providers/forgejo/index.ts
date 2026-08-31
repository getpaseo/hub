import type { AuthServer } from "../../auth/server.js";
import type { ForgejoConfigurationProvider } from "../../configuration/forgejo-sync.js";
import { createForgejoConfigSyncConsumer } from "../../configuration/forgejo-sync.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type { Database, OrganizationConnectionUsage } from "../../db/types.js";
import {
  envSecretEncryptionKeySource,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import {
  createForgejoClaimedHandoff,
  registerForgejoConfigSyncConsumer,
} from "../../triggers/forgejo/dispatch.js";
import { createForgejoPushSource } from "../../triggers/forgejo/push.js";
import { createForgejoTriggerProvider } from "../../triggers/forgejo/provider.js";
import type { AcceptVerifiedForgejoDelivery } from "../../triggers/forgejo/webhook.js";
import { createForgejoReceiptAcceptance } from "../../triggers/forgejo/receipt.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";
import { createForgejoAccessResolver } from "./access.js";
import { createDatabaseForgejoAuthorityStore } from "./authority-store.js";
import { createForgejoConfigurationProvider } from "./configuration.js";
import { handleForgejoConnectionsRequest } from "./connections.js";
import { createForgejoAuthorityRegistration } from "./execution-authority.js";
import { handleForgejoWebhookRequest } from "./hooks.js";
import {
  createDefaultForgejoHttp,
  handleForgejoInstancesRequest,
  type ForgejoDirectory,
  type ForgejoHttp,
} from "./instances.js";
import { handleForgejoRepositoriesRequest } from "./repositories.js";

export const FORGEJO_REQUEST_NAMES = [
  "forgejo.instances",
  "forgejo.connections",
  "forgejo.webhook",
] as const;

export const FORGEJO_IDENTITY = {
  provider: "forgejo",
  id: "forgejo",
  name: "Forgejo",
} as const;

const UNAVAILABLE = (): Promise<Response> =>
  Promise.resolve(Response.json({ error: "unavailable" }, { status: 409 }));

export interface CreateForgejoRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  publicBaseUrl?: string;
  configuration?: { provider: "forgejo" } | null;
  configurationProvider?: ForgejoConfigurationProvider;
  http?: ForgejoHttp;
  secrets?: SecretEncryptionKeySource;
  directory?: ForgejoDirectory;
  acceptForgejoDelivery?: AcceptVerifiedForgejoDelivery;
  onForgejoClaimed?: Parameters<typeof createForgejoReceiptAcceptance>[0]["onClaimed"];
}

export function createForgejoRegistration(
  options: CreateForgejoRegistrationOptions,
): ProviderRegistration {
  const configured = options.configuration !== null && options.configuration !== undefined;
  const live = liveForgejoRegistration(options);
  const configurationProvider = options.configurationProvider ?? live?.configurationProvider;
  return {
    connection: forgejoConnectionStatus(configured),
    ...(live === undefined ? {} : { integration: live.integration }),
    triggerProviders: live?.triggerProviders ?? [],
    sources: live?.sources ?? [],
    outputs: [],
    requests:
      live?.requests ?? FORGEJO_REQUEST_NAMES.map((name) => ({ name, handle: UNAVAILABLE })),
    ...(configurationProvider === undefined ? {} : { forgejoConfiguration: configurationProvider }),
  };
}

function liveForgejoRegistration(options: CreateForgejoRegistrationOptions):
  | {
      requests: ProviderRegistration["requests"];
      integration: NonNullable<ProviderRegistration["integration"]>;
      triggerProviders: ProviderRegistration["triggerProviders"];
      sources: ProviderRegistration["sources"];
      configurationProvider: ForgejoConfigurationProvider;
    }
  | undefined {
  if (options.database === null || options.auth === null) return undefined;
  const database = options.database;
  const directory = options.directory ?? database.forgejoDirectory();
  const http = options.http ?? createDefaultForgejoHttp();
  const secrets = options.secrets ?? envSecretEncryptionKeySource();
  const access = createForgejoAccessResolver(options.auth);
  const authority = createForgejoAuthorityRegistration({
    store: createDatabaseForgejoAuthorityStore(database),
    keys: secrets,
  });
  let configurationForProject: ((projectId: string) => ProjectConfigurationStore) | undefined;
  const configurationProvider =
    options.configurationProvider ??
    createForgejoConfigurationProvider({ directory, http, secrets });
  registerForgejoConfigSyncConsumer(
    createForgejoConfigSyncConsumer({
      database,
      client: configurationProvider,
      configurationForProject: (projectId) => {
        if (configurationForProject === undefined) {
          throw new Error("Forgejo configuration store is not initialized");
        }
        return configurationForProject(projectId);
      },
    }),
  );
  const connectionContext = async (connectionId: string) => {
    const row = await directory.findConnectionById(connectionId);
    if (row === undefined) return undefined;
    return { id: row.id, slug: row.slug, instanceId: row.instanceId };
  };
  const onClaimed =
    options.onForgejoClaimed ?? createForgejoClaimedHandoff({ connectionFor: connectionContext });
  const accept =
    options.acceptForgejoDelivery ??
    createForgejoReceiptAcceptance({
      database,
      onClaimed,
    });
  return {
    configurationProvider,
    triggerProviders: [
      ({ configurationStoreForProject }) => {
        configurationForProject = configurationStoreForProject;
        return createForgejoTriggerProvider({
          configurationStoreForProject,
          connectionFor: connectionContext,
        });
      },
    ],
    sources: [createForgejoPushSource({ database })],
    integration: {
      resolve() {
        return Promise.reject(new Error("forgejo_integration_unavailable"));
      },
      forgejoAuthority: authority,
    },
    requests: [
      {
        name: "forgejo.instances",
        handle: (request) =>
          handleForgejoInstancesRequest(rewriteForgejoRequest(request), {
            access,
            directory,
            http,
          }),
      },
      {
        name: "forgejo.connections",
        handle: (request) => {
          const rewritten = rewriteForgejoRequest(request);
          if (new URL(rewritten.url).pathname.includes("/repositories")) {
            return handleForgejoRepositoriesRequest(rewritten, {
              access,
              directory,
              http,
              secrets,
            });
          }
          return handleForgejoConnectionsRequest(rewritten, {
            access,
            directory,
            http,
            secrets,
          });
        },
      },
      {
        name: "forgejo.webhook",
        handle: (request) =>
          handleForgejoWebhookRequest(rewriteForgejoRequest(request), {
            access,
            directory,
            http,
            secrets,
            applicationBaseUrl: options.applicationBaseUrl,
            ...(options.publicBaseUrl === undefined
              ? {}
              : { publicBaseUrl: options.publicBaseUrl }),
            accept,
          }),
      },
    ],
  };
}

export function rewriteForgejoRequest(request: Request): Request {
  const url = new URL(request.url);
  const prefix = "/api/integrations/forgejo";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return request;
  url.pathname = url.pathname.slice(prefix.length) || "/";
  return new Request(url, request);
}

function forgejoConnectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "forgejo",
    status: (connections: OrganizationConnectionUsage) =>
      forgejoStatus(configured, connections.forgejo),
    actions: {
      start: UNAVAILABLE,
      disconnect: UNAVAILABLE,
    },
  };
}

function forgejoStatus(
  configured: boolean,
  connections: OrganizationConnectionUsage["forgejo"],
): { status: "notConfigured" | "configured"; connections: typeof connections } {
  return {
    status: configured ? "configured" : "notConfigured",
    connections,
  };
}
