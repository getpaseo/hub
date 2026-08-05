import { createHash } from "node:crypto";
import type { AuthServer } from "../../auth/server.js";
import {
  createGitHubAuth,
  type GitHubAuth,
  type GitHubExecutionTokenAuth,
} from "../../auth/github.js";
import { DatabaseUnavailableError } from "../../db/errors.js";
import type { Database, GitHubConnectionRecord } from "../../db/types.js";
import { logger } from "../../logger.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";
import {
  CONNECTION_ATTEMPT_LIFETIME_MINUTES,
  callbackConnectionAccess,
  connectionAccess,
  connectionActionFailure,
  connectionResult,
  manageConnectionAccess,
  newConnectionState,
  positiveInteger,
  readNonEmptyEnvironmentVariable,
  requiredConnectionId,
  stateHash,
} from "../../connections/shared.js";
import {
  createGitHubReactionClient,
  createGitHubTriggerProvider,
  type GitHubReactionClient,
} from "../../triggers/github/provider.js";
import { createWebhookSource } from "../../triggers/github/webhook.js";
import {
  createGitHubConnectionClient,
  type GitHubConnectionClient,
  type GitHubInstallationIdentity,
} from "./client.js";
import { PushPayloadSchema } from "../../auth/github-events.js";
import { synchronizeGitHubDefaultBranch } from "../../configuration/github-sync.js";
import type { GitHubConfigurationProvider } from "../../configuration/github-sync.js";
import { createGitHubConfigurationProvider } from "./configuration.js";
import type { ConnectionResolutionContext } from "../../config/connections.js";
import { createGitHubExecutionTokenRegistry } from "./execution-token-registry.js";

export interface GitHubRegistrationConfiguration {
  appSlug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

export interface CreateGitHubRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  publicBaseUrl?: string;
  environment?: NodeJS.ProcessEnv;
  configuration?: GitHubRegistrationConfiguration | null;
  appAuth?: GitHubAuth & GitHubExecutionTokenAuth;
  connectionClient?: GitHubConnectionClient;
  reactionClient?: GitHubReactionClient;
  fetch?: typeof fetch;
  configurationProvider?: GitHubConfigurationProvider;
}

interface GitHubConnectionOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
}

export function createGitHubRegistration(
  options: CreateGitHubRegistrationOptions,
): ProviderRegistration {
  const configuration =
    options.configuration === undefined
      ? readGitHubConfiguration(options.publicBaseUrl, options.environment ?? process.env)
      : options.configuration;
  if (configuration === null || options.publicBaseUrl === undefined) {
    return emptyGitHubRegistration(options);
  }
  if (options.database === null) {
    return databaseUnavailableGitHubRegistration(configuration);
  }
  const database = options.database;

  const appAuth = options.appAuth ?? createGitHubAuth();
  const executionTokenRegistry = createGitHubExecutionTokenRegistry(appAuth);
  const client =
    options.connectionClient ??
    createGitHubConnectionClient({
      publicBaseUrl: options.publicBaseUrl,
      appSlug: configuration.appSlug,
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
      appAuth,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const connection =
    options.auth === null
      ? githubConnectionStatus(true)
      : createGitHubConnection(
          {
            database,
            auth: options.auth,
            applicationBaseUrl: options.applicationBaseUrl,
          },
          client,
        );
  const webhook = createWebhookSource(configuration.webhookSecret, {
    accept: (input) => database.acceptGitHubTrigger(input),
    applyLifecycle: (delivery) => applyLifecycle(database, client, delivery),
    async synchronizePush(input) {
      const payload = PushPayloadSchema.safeParse(input.payload);
      if (!payload.success) return;
      const incomingConnection = await database.findGitHubConnection(input.installationId);
      if (incomingConnection === undefined) return;
      const targets = await database.listGitHubConfigurationTargets(
        incomingConnection.organizationId,
        incomingConnection.id,
        input.repositoryId,
      );
      await Promise.all(
        targets
          .filter((target) => payload.data.ref === `refs/heads/${target.defaultBranch}`)
          .map((target) =>
            synchronizeGitHubDefaultBranch({
              database,
              client: githubConfiguration,
              projectId: target.projectId,
              repositoryId: input.repositoryId,
              expectedCommitSha: payload.data.after,
              webhookDeliveryId: input.deliveryId,
            }),
          ),
      );
    },
  });
  const githubConfiguration =
    options.configurationProvider ?? createGitHubConfigurationProvider(appAuth);
  const reactions = options.reactionClient ?? createGitHubReactionClient(appAuth);
  logger.info("using webhook event source");
  return {
    connection,
    integration: {
      onExecutionTerminal: (executionId) => executionTokenRegistry.onExecutionTerminal(executionId),
      async resolve(projectId, connectionSlug, value, context?: ConnectionResolutionContext) {
        if (value !== "token") {
          throw new Error(`unsupported github integration value: ${value}`);
        }
        const project = await database.findProjectById(projectId);
        const selectedConnection =
          project === undefined
            ? undefined
            : (await database.organizationConnectionUsage(project.organizationId)).github.find(
                (candidate) => candidate.slug === connectionSlug,
              );
        if (selectedConnection === undefined || selectedConnection.status !== "active") {
          throw new Error(`github connection is unavailable: ${connectionSlug}`);
        }
        const token =
          context?.executionId !== undefined && context.registerToken === undefined
            ? await executionTokenRegistry.mint(context.executionId, () =>
                appAuth.mintInstallationToken(selectedConnection.installationId),
              )
            : await appAuth.mintInstallationToken(selectedConnection.installationId);
        await context?.registerToken?.(token);
        return token;
      },
    },
    triggerProviders: [
      ({ configurationStoreForProject, connectionsForProject }) =>
        createGitHubTriggerProvider({
          configurationStoreForProject,
          connectionsForProject,
          reactions,
          executionTokens: appAuth,
        }),
    ],
    sources: [webhook],
    outputs: [],
    requests: [{ name: "webhook", handle: (request) => webhook.handle(request) }],
    githubConfiguration,
  };
}

function emptyGitHubRegistration(
  options: Pick<CreateGitHubRegistrationOptions, "database" | "auth" | "applicationBaseUrl">,
): ProviderRegistration {
  const { database, auth } = options;
  const connection =
    database === null || auth === null
      ? githubConnectionStatus(false)
      : createGitHubConnection(
          { database, auth, applicationBaseUrl: options.applicationBaseUrl },
          undefined,
        );
  return {
    connection,
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests: [],
  };
}

function databaseUnavailableGitHubRegistration(
  configuration: GitHubRegistrationConfiguration,
): ProviderRegistration {
  const unavailable = () => Promise.reject(new DatabaseUnavailableError());
  const webhook = createWebhookSource(configuration.webhookSecret, {
    accept: unavailable,
    applyLifecycle: unavailable,
  });
  return {
    connection: githubConnectionStatus(true),
    triggerProviders: [],
    sources: [webhook],
    outputs: [],
    requests: [{ name: "webhook", handle: (request) => webhook.handle(request) }],
  };
}

function githubConnectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "github",
    status: (connections) => githubStatus(configured, connections.github),
    actions: {},
  };
}

function createGitHubConnection(
  options: GitHubConnectionOptions,
  client: GitHubConnectionClient | undefined,
): ProviderConnectionRegistration {
  const start = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      if (client === undefined) {
        return Response.json({ error: "provider_not_configured" }, { status: 409 });
      }
      const state = newConnectionState();
      await options.database.startConnectionAttempt({
        provider: "github",
        stateVerifier: stateHash(state),
        access: connectionAccess(access),
        lifetimeMinutes: CONNECTION_ATTEMPT_LIFETIME_MINUTES,
      });
      return Response.json({ url: client.setupUrl(state) });
    } catch (error) {
      return connectionActionFailure(error, "github", "start");
    }
  };

  const disconnect = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      await options.database.disconnectConnection(
        "github",
        requiredConnectionId(request),
        connectionAccess(access),
      );
      return Response.json({ disconnected: true });
    } catch (error) {
      return connectionActionFailure(error, "github", "disconnect");
    }
  };

  return {
    name: "github",
    status: (connections) => githubStatus(client !== undefined, connections.github),
    actions: {
      start,
      disconnect,
      setup: (request) => completeSetup(options, client, request),
      callback: (request) => completeAuthorization(options, client, request),
    },
  };
}

async function completeSetup(
  options: GitHubConnectionOptions,
  client: GitHubConnectionClient | undefined,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const installationId = positiveInteger(url.searchParams.get("installation_id"));
  const action = url.searchParams.get("setup_action");
  if (state === null || client === undefined)
    return connectionResult(options.applicationBaseUrl, "/", "connection_unavailable");
  let returnRoute = "/";
  try {
    const access = await callbackConnectionAccess(options.auth, request);
    const attempt = await options.database.readConnectionAttempt({
      stateVerifier: stateHash(state),
      phase: "github_setup",
      access,
    });
    returnRoute = attempt.returnRoute;
    if (action === "request") {
      await options.database.consumeConnectionAttempt({
        stateVerifier: stateHash(state),
        phase: "github_setup",
        access,
      });
      return connectionResult(
        options.applicationBaseUrl,
        attempt.returnRoute,
        "github_approval_required",
      );
    }
    if ((action !== "install" && action !== "update") || installationId === undefined) {
      return connectionResult(
        options.applicationBaseUrl,
        attempt.returnRoute,
        "connection_unavailable",
      );
    }
    const nextState = newConnectionState();
    const verifier = newConnectionState();
    await options.database.advanceGitHubConnectionAttempt({
      stateVerifier: stateHash(state),
      phase: "github_setup",
      access,
      nextStateVerifier: stateHash(nextState),
      installationId,
      pkceVerifier: verifier,
    });
    return Response.redirect(
      client.authorizationUrl({
        state: nextState,
        challenge: pkceChallenge(verifier),
      }),
      303,
    );
  } catch {
    return connectionResult(options.applicationBaseUrl, returnRoute, "connection_unavailable");
  }
}

async function completeAuthorization(
  options: GitHubConnectionOptions,
  client: GitHubConnectionClient | undefined,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (state === null || code === null || client === undefined) {
    return connectionResult(options.applicationBaseUrl, "/", "connection_unavailable");
  }
  let returnRoute = "/";
  try {
    const access = await callbackConnectionAccess(options.auth, request);
    const attempt = await options.database.readConnectionAttempt({
      stateVerifier: stateHash(state),
      phase: "github_user_authorization",
      access,
    });
    returnRoute = attempt.returnRoute;
    const installationId = positiveInteger(attempt.candidateExternalId);
    if (installationId === undefined || attempt.pkceVerifier === null)
      throw new Error("invalid attempt");
    const identity = await client.verifyUserInstallation({
      code,
      verifier: attempt.pkceVerifier,
      installationId,
    });
    if (identity === undefined) {
      await options.database.consumeConnectionAttempt({
        stateVerifier: stateHash(state),
        phase: "github_user_authorization",
        access,
      });
      return connectionResult(
        options.applicationBaseUrl,
        attempt.returnRoute,
        "connection_unavailable",
      );
    }
    await bindGitHub(options.database, state, access, identity);
    return connectionResult(options.applicationBaseUrl, attempt.returnRoute, "github_connected");
  } catch {
    return connectionResult(options.applicationBaseUrl, returnRoute, "connection_unavailable");
  }
}

async function bindGitHub(
  database: Database,
  state: string,
  access: Awaited<ReturnType<typeof callbackConnectionAccess>>,
  identity: GitHubInstallationIdentity,
): Promise<void> {
  await database.bindGitHubConnection({
    stateVerifier: stateHash(state),
    phase: "github_user_authorization",
    access,
    ...identity,
  });
}

interface GitHubLifecycleDelivery {
  installationId: number;
  event: "installation" | "installation_repositories";
  deliveryId: string;
  signatureHash: string;
  source: string;
  payload: unknown;
  receivedAt: Date;
}

async function applyLifecycle(
  database: Database,
  client: GitHubConnectionClient,
  delivery: GitHubLifecycleDelivery,
): Promise<void> {
  const claim = await database.claimGitHubLifecycle(delivery);
  if (claim.status === "duplicate") return;
  try {
    const evidence = await client.getInstallation(delivery.installationId);
    if (evidence.status === "absent") {
      await database.applyGitHubLifecycle(claim, {
        status: "absent",
        removeBinding: delivery.event === "installation",
      });
      return;
    }
    await database.applyGitHubLifecycle(claim, {
      status: "present",
      identity: evidence.identity,
    });
  } catch (error) {
    await database.releaseGitHubLifecycleClaim(claim.triggerId);
    throw error;
  }
}

function githubStatus(configured: boolean, bindings: readonly GitHubConnectionRecord[]) {
  if (!configured) return { status: "notConfigured" as const };
  if (bindings.length === 0) return { status: "disconnected" as const };
  return bindings.every((binding) => binding.status === "suspended")
    ? { status: "suspended" as const }
    : { status: "connected" as const };
}

function readGitHubConfiguration(
  publicBaseUrl: string | undefined,
  environment: NodeJS.ProcessEnv,
): GitHubRegistrationConfiguration | null {
  if (publicBaseUrl === undefined) return null;
  const appSlug = readNonEmptyEnvironmentVariable(environment, "GITHUB_APP_SLUG");
  const clientId = readNonEmptyEnvironmentVariable(environment, "GITHUB_APP_CLIENT_ID");
  const clientSecret = readNonEmptyEnvironmentVariable(environment, "GITHUB_APP_CLIENT_SECRET");
  const appId = readNonEmptyEnvironmentVariable(environment, "GITHUB_APP_ID");
  const privateKey = readNonEmptyEnvironmentVariable(environment, "GITHUB_APP_PRIVATE_KEY");
  const privateKeyPath = readNonEmptyEnvironmentVariable(
    environment,
    "GITHUB_APP_PRIVATE_KEY_PATH",
  );
  const webhookSecret = readNonEmptyEnvironmentVariable(environment, "GITHUB_WEBHOOK_SECRET");
  if (
    appSlug === undefined ||
    clientId === undefined ||
    clientSecret === undefined ||
    appId === undefined ||
    (privateKey === undefined && privateKeyPath === undefined) ||
    webhookSecret === undefined
  ) {
    return null;
  }
  return {
    appSlug,
    clientId,
    clientSecret,
    webhookSecret,
  };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
