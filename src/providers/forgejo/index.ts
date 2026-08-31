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
import {
  createForgejoHydrationSource,
  createForgejoHydrationTriggerProvider,
  seedForgejoHydrationForRepository,
} from "../../triggers/forgejo/hydration.js";
import {
  createForgejoItemSource,
  createForgejoItemTriggerProvider,
} from "../../triggers/forgejo/items.js";
import {
  createForgejoCommentSource,
  createForgejoCommentTriggerProvider,
} from "../../triggers/forgejo/comments.js";
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
import { createForgejoHydrationClient } from "./hydration-client.js";
import { createForgejoHydrationReactionClient } from "../../triggers/forgejo/hydration-reactions.js";
import { createForgejoItemReactionClient } from "../../triggers/forgejo/item-reactions.js";
import { createForgejoCommentReactionClient } from "../../triggers/forgejo/comment-reactions.js";
import {
  createDefaultForgejoHttp,
  ForgejoContractError,
  forgejoErrorResponse,
  handleForgejoInstancesRequest,
  requireOrganizationOwner,
  type ForgejoDirectory,
  type ForgejoHttp,
} from "./instances.js";
import { handleForgejoRepositoriesRequest } from "./repositories.js";
import { createDatabaseForgejoLifecycleImpactSource, createForgejoLifecycle } from "./lifecycle.js";

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
    connection: forgejoConnectionStatus(configured, live?.disconnect),
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
      disconnect: (request: Request) => Promise<Response>;
    }
  | undefined {
  if (options.database === null || options.auth === null) return undefined;
  const database = options.database;
  const directory = options.directory ?? database.forgejoDirectory();
  const http = options.http ?? createDefaultForgejoHttp();
  const secrets = options.secrets ?? envSecretEncryptionKeySource();
  const access = createForgejoAccessResolver(options.auth);
  const lifecycle = createForgejoLifecycle({
    directory,
    http,
    secrets,
    impactSource: createDatabaseForgejoLifecycleImpactSource(database),
  });
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
  const hydrationClient = createForgejoHydrationClient({ directory, http, secrets });
  const hydrationStore = database.forgejoHydration();
  const onEnrolled = async (input: {
    connectionId: string;
    organizationId: string;
    repositories: { enrolled: boolean; repositoryId: number; ownerLogin: string; name: string }[];
  }) => {
    for (const repository of input.repositories) {
      if (!repository.enrolled) continue;
      await seedForgejoHydrationForRepository({
        store: hydrationStore,
        client: hydrationClient,
        connectionId: input.connectionId,
        repositoryId: repository.repositoryId,
        owner: repository.ownerLogin,
        repo: repository.name,
      });
    }
  };
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
    disconnect: (request) => handleForgejoDisconnectAction(request, { access, lifecycle }),
    triggerProviders: [
      ({ configurationStoreForProject }) => {
        configurationForProject = configurationStoreForProject;
        return createForgejoTriggerProvider({
          configurationStoreForProject,
          connectionFor: connectionContext,
        });
      },
      ({ configurationStoreForProject }) =>
        createForgejoHydrationTriggerProvider({
          configurationStoreForProject,
          reactions: createForgejoHydrationReactionClient({ directory, http, secrets }),
        }),
      ({ configurationStoreForProject }) =>
        createForgejoItemTriggerProvider({
          configurationStoreForProject,
          connectionFor: connectionContext,
          reactions: createForgejoItemReactionClient({ directory, http, secrets }),
        }),
      ({ configurationStoreForProject }) =>
        createForgejoCommentTriggerProvider({
          configurationStoreForProject,
          connectionFor: connectionContext,
          reactions: createForgejoCommentReactionClient({ directory, http, secrets }),
        }),
    ],
    sources: [
      createForgejoPushSource({ database }),
      createForgejoItemSource({ database }),
      createForgejoCommentSource({ database }),
      createForgejoHydrationSource({
        store: hydrationStore,
        client: hydrationClient,
        listTargets: (input) =>
          database.listActiveTriggerDispatchTargets({
            organizationId: input.organizationId,
            provider: "forgejo",
            connectionId: input.connectionId,
            resourceId: String(input.repositoryId),
          }),
      }),
    ],
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
              onEnrolled,
            });
          }
          return handleForgejoConnectionsRequest(rewritten, {
            access,
            directory,
            http,
            secrets,
            onEnrolled,
            lifecycle,
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

function forgejoConnectionStatus(
  configured: boolean,
  disconnect: (request: Request) => Promise<Response> = UNAVAILABLE,
): ProviderConnectionRegistration {
  return {
    name: "forgejo",
    status: (connections: OrganizationConnectionUsage) =>
      forgejoStatus(configured, connections.forgejo),
    actions: {
      start: UNAVAILABLE,
      disconnect,
    },
  };
}

async function handleForgejoDisconnectAction(
  request: Request,
  input: {
    access: ReturnType<typeof createForgejoAccessResolver>;
    lifecycle: ReturnType<typeof createForgejoLifecycle>;
  },
): Promise<Response> {
  try {
    const access = await input.access.resolve(request);
    const organizationId = requireOrganizationOwner(access);
    const connectionId = new URL(request.url).searchParams.get("connectionId");
    if (
      connectionId === null ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        connectionId,
      )
    ) {
      throw new ForgejoContractError("forgejo_origin_invalid", 400, "connectionId is required");
    }
    const result = await input.lifecycle.disconnect({ organizationId, connectionId });
    return Response.json(result, {
      status: result.cleanupStatus === "complete" ? 200 : 202,
    });
  } catch (error) {
    return forgejoErrorResponse(error);
  }
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
