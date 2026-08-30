import type { AuthServer } from "../../auth/server.js";
import type { ForgejoConfigurationProvider } from "../../configuration/forgejo-sync.js";
import type { Database, OrganizationConnectionUsage } from "../../db/types.js";
import {
  envSecretEncryptionKeySource,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";
import { createForgejoAccessResolver } from "./access.js";
import { createDatabaseForgejoAuthorityStore } from "./authority-store.js";
import { handleForgejoConnectionsRequest } from "./connections.js";
import { createForgejoAuthorityRegistration } from "./execution-authority.js";
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
}

export function createForgejoRegistration(
  options: CreateForgejoRegistrationOptions,
): ProviderRegistration {
  const configured = options.configuration !== null && options.configuration !== undefined;
  const live = liveForgejoRegistration(options);
  return {
    connection: forgejoConnectionStatus(configured),
    ...(live === undefined ? {} : { integration: live.integration }),
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests:
      live?.requests ?? FORGEJO_REQUEST_NAMES.map((name) => ({ name, handle: UNAVAILABLE })),
    ...(options.configurationProvider === undefined
      ? {}
      : { forgejoConfiguration: options.configurationProvider }),
  };
}

function liveForgejoRegistration(options: CreateForgejoRegistrationOptions):
  | {
      requests: ProviderRegistration["requests"];
      integration: NonNullable<ProviderRegistration["integration"]>;
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
  return {
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
      { name: "forgejo.webhook", handle: UNAVAILABLE },
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
