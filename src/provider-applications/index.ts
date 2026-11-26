import type { AccountAccessValue } from "../auth/organization-access.js";
import type { JsonValue } from "../config/compiler.js";
import type {
  BindLinearConnectionInput,
  BindSlackConnectionInput,
  Database,
  ReadConnectionAttemptInput,
} from "../db/types.js";
import type {
  BindIntegrationConnectionPayload,
  IntegrationAppIdentity,
  IntegrationDefinition,
  IntegrationOAuthCompletionInput,
} from "../integrations/contracts.js";
import { defaultIntegrationRegistry, type IntegrationRegistry } from "../integrations/registry.js";
import type { LinearInstallation } from "../providers/linear/client.js";
import type { SlackSocketInstallationVerifier } from "../providers/slack/installation.js";
import type { SlackDeliveryStatus } from "../triggers/slack/source/index.js";
import { TRUSTED_REQUEST_ORIGIN_HEADER } from "../http/request-origin.js";
import { parseProviderApplicationConfiguration } from "./internal/store.js";
import { errorForLog, logger } from "../logger.js";
import { sensitiveConfigurationValues } from "./internal/configuration-secrets.js";
import { classifyFailure, reportFailure } from "../failures/index.js";

export const PROVIDERS = ["github", "slack", "discord", "linear"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type ApplicationProvider = string;

export interface GitHubProviderApplicationConfiguration {
  provider: "github";
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  /** Absent until the operator sets up event triggers, which need a public HTTPS address. */
  webhookSecret?: string;
  expectedVersion?: number;
}

export type SlackProviderApplicationConfiguration =
  | {
      provider: "slack";
      transport: "socket";
      appId: string;
      appToken: string;
      expectedVersion?: number;
    }
  | {
      provider: "slack";
      transport: "webhook";
      appId: string;
      clientId: string;
      clientSecret: string;
      signingSecret: string;
      expectedVersion?: number;
    };

export interface DiscordProviderApplicationConfiguration {
  provider: "discord";
  applicationId: string;
  clientSecret: string;
  botToken: string;
  expectedVersion?: number;
}

export interface LinearProviderApplicationConfiguration {
  provider: "linear";
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  expectedVersion?: number;
}

export type ProviderApplicationConfiguration =
  | GitHubProviderApplicationConfiguration
  | SlackProviderApplicationConfiguration
  | DiscordProviderApplicationConfiguration
  | LinearProviderApplicationConfiguration;

export interface RegisteredProviderApplicationConfiguration {
  readonly provider: string;
  readonly expectedVersion?: number;
  readonly [key: string]: unknown;
}

export type AnyProviderApplicationConfiguration =
  | ProviderApplicationConfiguration
  | RegisteredProviderApplicationConfiguration;

export interface ProviderApplicationEnvironment {
  readonly github?: GitHubProviderApplicationConfiguration;
  readonly slack?: SlackProviderApplicationConfiguration;
  readonly discord?: DiscordProviderApplicationConfiguration;
  readonly linear?: LinearProviderApplicationConfiguration;
  readonly registered?: Readonly<Record<string, RegisteredProviderApplicationConfiguration>>;
}

export function isLegacyProvider(provider: string): provider is Provider {
  return (
    provider === "github" || provider === "slack" || provider === "discord" || provider === "linear"
  );
}

export function isLegacyProviderApplicationConfiguration(
  configuration: AnyProviderApplicationConfiguration,
): configuration is ProviderApplicationConfiguration {
  return isLegacyProvider(configuration.provider);
}

function environmentConfigurationFor(
  environment: ProviderApplicationEnvironment,
  provider: ApplicationProvider,
): AnyProviderApplicationConfiguration | undefined {
  if (isLegacyProvider(provider)) return environment[provider];
  return environment.registered?.[provider];
}

export type ProviderApplicationIdentity =
  | { provider: "github"; id: string; name: string; ownerLogin: string }
  | { provider: "slack"; id: string; name: string }
  | { provider: "discord"; id: string; name: string }
  | { provider: "linear"; id: string; name: string };

export type AnyProviderApplicationIdentity = ProviderApplicationIdentity | IntegrationAppIdentity;

export interface StoredProviderApplication {
  provider: ApplicationProvider;
  configuration: AnyProviderApplicationConfiguration;
  identity: AnyProviderApplicationIdentity;
  version: number;
  verifiedAt: Date;
  updatedAt: Date;
  updatedByUserId: string | null;
}

export interface ProviderApplicationStore {
  read(provider: ApplicationProvider): Promise<StoredProviderApplication | undefined>;
  readAll(): Promise<readonly StoredProviderApplication[]>;
  save(input: {
    provider: ApplicationProvider;
    configuration: AnyProviderApplicationConfiguration;
    identity: AnyProviderApplicationIdentity;
    expectedVersion: number | undefined;
    updatedByUserId: string;
  }): Promise<StoredProviderApplication>;
  activate(input: {
    provider: ApplicationProvider;
    identity: AnyProviderApplicationIdentity;
    configurationVersion: number;
  }): Promise<void>;
  completeSlackInstallation(input: {
    configuration: SlackProviderApplicationConfiguration;
    identity: Extract<ProviderApplicationIdentity, { provider: "slack" }>;
    expectedVersion: number | undefined;
    updatedByUserId: string;
    binding: BindSlackConnectionInput;
  }): Promise<void>;
  completeSlackSocketApplication(input: {
    configuration: Extract<SlackProviderApplicationConfiguration, { transport: "socket" }>;
    identity: Extract<ProviderApplicationIdentity, { provider: "slack" }>;
    expectedVersion: number | undefined;
    updatedByUserId: string;
    organizationId: string;
    installation: VerifiedSlackInstallation;
  }): Promise<StoredProviderApplication>;
  completeLinearInstallation(input: {
    configuration: LinearProviderApplicationConfiguration;
    identity: Extract<ProviderApplicationIdentity, { provider: "linear" }>;
    expectedVersion: number | undefined;
    updatedByUserId: string;
    installation: LinearInstallation;
    binding: BindLinearConnectionInput;
  }): Promise<void>;
  completeIntegrationInstallation?(input: {
    provider: string;
    configuration: AnyProviderApplicationConfiguration;
    identity: IntegrationAppIdentity;
    expectedVersion: number | undefined;
    updatedByUserId: string;
    attempt: ReadConnectionAttemptInput;
    connection: BindIntegrationConnectionPayload;
  }): Promise<void>;
  completeDirectIntegrationApplication?(input: {
    provider: string;
    configuration: AnyProviderApplicationConfiguration;
    identity: IntegrationAppIdentity;
    expectedVersion: number | undefined;
    updatedByUserId: string;
    organizationId: string;
    connection: BindIntegrationConnectionPayload;
  }): Promise<StoredProviderApplication>;
}

export interface ProviderRuntimeCandidate {
  start(): Promise<void>;
  beginConnection?(request: Request): Promise<{ url: string }>;
  /** Publication is an in-memory pointer replacement and must not perform fallible work. */
  publish(): void;
  close(): Promise<void>;
}

export interface ProviderRuntimeOwner {
  prepare(
    provider: ApplicationProvider,
    configuration: AnyProviderApplicationConfiguration,
    callbackOrigin: string,
    identity: AnyProviderApplicationIdentity,
    configurationVersion: number,
    activation?: {
      expectedConfigurationVersion: number | undefined;
      activateConfiguration: boolean;
    },
  ): Promise<ProviderRuntimeCandidate>;
  identity?(provider: ApplicationProvider): AnyProviderApplicationIdentity | undefined;
  onSlackInstallation?(
    handler: (input: {
      configuration: unknown;
      expectedConfigurationVersion: number | undefined;
      callbackOrigin: string;
      userId: string;
      installation: VerifiedSlackInstallation;
      binding: BindSlackConnectionInput;
    }) => Promise<void>,
  ): void;
  onLinearInstallation?(
    handler: (input: {
      configuration: unknown;
      expectedConfigurationVersion: number | undefined;
      callbackOrigin: string;
      userId: string;
      installation: LinearInstallation;
      binding: BindLinearConnectionInput;
    }) => Promise<void>,
  ): void;
  onIntegrationOAuthInstallation?(
    handler: (input: IntegrationOAuthCompletionInput) => Promise<void>,
  ): void;
}

export interface ProviderApplicationVerifier {
  verify(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
    context?: { callbackOrigin?: string },
  ): Promise<ProviderApplicationIdentity>;
  verifyDirect?(
    provider: ApplicationProvider,
    configuration: AnyProviderApplicationConfiguration,
    context?: { callbackOrigin?: string },
  ): Promise<
    | {
        readonly identity: IntegrationAppIdentity;
        readonly initialConnection?: BindIntegrationConnectionPayload;
      }
    | undefined
  >;
}

export interface ConnectedProviderIdentity {
  id: string;
  name: string;
  applicationId: string | null;
  status: "connected" | "actionNeeded";
}

export interface ProviderApplicationInventory {
  connectedIdentities(provider: ApplicationProvider): Promise<readonly ConnectedProviderIdentity[]>;
  /** Durably assigns pre-feature, unowned connections before their environment runtime publishes. */
  claimLegacyConnections(
    provider: ApplicationProvider,
    identity: AnyProviderApplicationIdentity,
  ): Promise<boolean>;
  lastEventAt(
    provider: ApplicationProvider,
    identity: AnyProviderApplicationIdentity,
    configurationVersion: number,
  ): Promise<Date | null>;
}

export type ProviderApplicationStatus =
  | "notConfigured"
  | "verified"
  | "connected"
  | "actionNeeded"
  | "managedByEnvironment";

export interface ProviderApplicationView {
  provider: ApplicationProvider;
  status: ProviderApplicationStatus;
  managedByEnvironment: boolean;
  identifiers: Readonly<Record<string, string>>;
  identity: AnyProviderApplicationIdentity | null;
  connections: readonly ConnectedProviderIdentity[];
  /**
   * Whether inbound deliveries can be admitted at all. GitHub's webhook secret is optional, and
   * without it every delivery is rejected — so the surface must not offer to wait for an event
   * that can never be accepted.
   */
  eventsConfigured: boolean;
  lastEventAt: string | null;
  replaceable: boolean;
  configurationVersion: number | null;
  deliveryStatus?: SlackDeliveryStatus;
}

export interface ProviderApplicationOverview {
  callbackOrigin: string;
  providers: Record<Provider, ProviderApplicationView> &
    Partial<Record<string, ProviderApplicationView>>;
}

export interface ProviderApplicationResult {
  status: "verified";
  provider: ApplicationProvider;
  identity: AnyProviderApplicationIdentity;
  configurationVersion: number;
}

export interface ProviderApplicationContinuation {
  status: "continuing";
  provider: ApplicationProvider;
  url: string;
}

export type ProviderApplicationSaveResult =
  | ProviderApplicationResult
  | ProviderApplicationContinuation;

export interface VerifiedSlackInstallation {
  appId: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  botAccessToken: string;
  scopes: string[];
}

export type ProviderApplicationErrorCode =
  | "forbidden"
  | "invalidOrigin"
  | "invalidInput"
  | "credentialsRejected"
  | "permissionMissing"
  | "rateLimited"
  | "network"
  | "timeout"
  | "upstreamUnavailable"
  | "invalidResponse"
  | "internal"
  | "identityConflict"
  | "configurationConflict"
  | "managedByEnvironment"
  | "httpsRequired";

export class ProviderApplicationError extends Error {
  constructor(
    readonly code: ProviderApplicationErrorCode,
    readonly safeContext?: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ProviderApplicationError";
  }
}

/**
 * Which credential the provider actually objected to. Collapsing "this secret is wrong" into
 * "these credentials are wrong" sends the operator back to the portal to re-copy every field,
 * and collapsing "this belongs to a different app" into either one sends them looking for a
 * typo that is not there.
 */
export type ProviderVerificationSubject =
  | "appToken"
  | "botToken"
  | "clientSecret"
  | "privateKey"
  | "identityMismatch";

export class ProviderVerificationError extends Error {
  constructor(
    readonly reason:
      | "credentialsRejected"
      | "permissionMissing"
      | "rateLimited"
      | "network"
      | "timeout"
      | "upstreamUnavailable"
      | "invalidResponse",
    readonly safeStatus?: number,
    options?: ErrorOptions & { subject?: ProviderVerificationSubject },
  ) {
    super(reason, options);
    this.name = "ProviderVerificationError";
    this.subject = options?.subject;
  }

  readonly subject: ProviderVerificationSubject | undefined;
}

/**
 * Which Hub surface an OAuth or install round trip has to come back to. An enum rather than a
 * route, so a browser can only choose between Hub's own two app surfaces and never supply a
 * redirect target of its own.
 */
export type ProviderApplicationSurface = "appSetup" | "apps";

export const PROVIDER_APPLICATION_RETURN_ROUTES: Readonly<
  Record<ProviderApplicationSurface, string>
> = { appSetup: "/", apps: "/apps" };

export function providerApplicationReturnRoute(
  surface: ProviderApplicationSurface | undefined,
): string {
  return PROVIDER_APPLICATION_RETURN_ROUTES[surface ?? "apps"];
}

export interface ProviderApplications {
  overview(request: Request): Promise<ProviderApplicationOverview>;
  verifyAndSave(
    request: Request,
    provider: ApplicationProvider,
    input: AnyProviderApplicationConfiguration,
    surface?: ProviderApplicationSurface,
  ): Promise<ProviderApplicationSaveResult>;
  beginConnection(
    request: Request,
    provider: ApplicationProvider,
    organizationId: string,
    surface?: ProviderApplicationSurface,
  ): Promise<{ url: string }>;
  configureSlackSocket(
    request: Request,
    input: { appToken: string; botToken: string; expectedVersion?: number },
  ): Promise<ProviderApplicationResult>;
  retrySlackSocket(request: Request): Promise<void>;
  runSetupAction?(
    request: Request,
    provider: ApplicationProvider,
    action: string,
    payload?: unknown,
  ): Promise<JsonValue>;
}

interface ProviderApplicationsOptions {
  auth: {
    resolveAccount(request: Request): Promise<AccountAccessValue>;
    rejectCookieMutation(request: Request): Response | undefined;
  };
  store: ProviderApplicationStore;
  environment: ProviderApplicationEnvironment;
  runtime: ProviderRuntimeOwner;
  verifier: ProviderApplicationVerifier;
  inventory: ProviderApplicationInventory;
  callbackOrigin(request: Request): string | Promise<string>;
  registry?: IntegrationRegistry;
  database?: Database;
  fetch?: typeof fetch;
  now?: () => Date;
  beginCandidateConnection?: (
    request: Request,
    organizationId: string,
    returnRoute: string,
    begin: (request: Request) => Promise<{ url: string }>,
  ) => Promise<{ url: string }>;
  slackSocketVerifier?: SlackSocketInstallationVerifier;
  slackDelivery?: { status(): SlackDeliveryStatus; retry(): Promise<void> };
}

export function createProviderApplications(
  options: ProviderApplicationsOptions,
): ProviderApplications {
  const registry = options.registry ?? defaultIntegrationRegistry;
  const queues = new Map<ApplicationProvider, Promise<void>>();
  options.runtime.onSlackInstallation?.((input) =>
    serialize(queues, "slack", () => completeSlackInstallation(options, input)),
  );
  options.runtime.onLinearInstallation?.((input) =>
    serialize(queues, "linear", () => completeLinearInstallation(options, input)),
  );
  options.runtime.onIntegrationOAuthInstallation?.((input) =>
    serialize(queues, input.provider, () =>
      completeIntegrationInstallation(options, registry, input),
    ),
  );

  return {
    async overview(request) {
      await requireOperator(options, request);
      const callbackOrigin = await safeCallbackOrigin(options, request);
      const stored = new Map(
        (await options.store.readAll()).map((value) => [value.provider, value]),
      );
      const providerIds: readonly ApplicationProvider[] = [...PROVIDERS, ...registry.ids()];
      const entries = await Promise.all(
        // eslint-disable-next-line complexity -- this is the single projection of provider state.
        providerIds.map(async (provider) => {
          const environment = environmentConfigurationFor(options.environment, provider);
          const persisted = stored.get(provider);
          const resolved = environment ?? persisted?.configuration;
          const connections = await options.inventory.connectedIdentities(provider);
          const identity = options.runtime.identity?.(provider) ?? persisted?.identity ?? null;
          const status = providerStatus(environment !== undefined, identity, connections);
          const configurationVersion = environment === undefined ? (persisted?.version ?? null) : 0;
          const deliveryStatus = provider === "slack" ? options.slackDelivery?.status() : undefined;
          const view: ProviderApplicationView = {
            provider,
            status,
            managedByEnvironment: environment !== undefined,
            identifiers: resolved === undefined ? {} : publicIdentifiers(resolved, registry),
            identity,
            connections,
            eventsConfigured: acceptsEvents(resolved, registry),
            lastEventAt:
              provider === "discord" || identity === null || configurationVersion === null
                ? null
                : ((
                    await options.inventory.lastEventAt(provider, identity, configurationVersion)
                  )?.toISOString() ?? null),
            replaceable: connections.length === 0,
            configurationVersion,
            ...(deliveryStatus === undefined ? {} : { deliveryStatus }),
          };
          return [provider, view] as const;
        }),
      );
      const byProvider = Object.fromEntries(entries);
      const github = byProvider["github"];
      const slack = byProvider["slack"];
      const discord = byProvider["discord"];
      const linear = byProvider["linear"];
      if (
        github === undefined ||
        slack === undefined ||
        discord === undefined ||
        linear === undefined
      ) {
        throw new Error("provider overview is incomplete");
      }
      return {
        callbackOrigin,
        providers: { ...byProvider, github, slack, discord, linear },
      };
    },

    async verifyAndSave(request, provider, input, surface) {
      rejectMutation(options, request);
      const account = await requireOperator(options, request);
      const callbackOrigin = await safeCallbackOrigin(options, request);
      if (environmentConfigurationFor(options.environment, provider) !== undefined) {
        throw new ProviderApplicationError("managedByEnvironment");
      }
      if (input.provider !== provider) throw new ProviderApplicationError("invalidInput");
      return serialize<ProviderApplicationSaveResult>(queues, provider, () => {
        const returnRoute = providerApplicationReturnRoute(surface);
        const integration = registry.get(provider);
        if (integration !== undefined) {
          return saveRegisteredIntegration(
            options,
            integration,
            request,
            account,
            callbackOrigin,
            input,
            returnRoute,
          );
        }
        if (!isLegacyProvider(provider) || !isLegacyProviderApplicationConfiguration(input)) {
          throw new ProviderApplicationError("invalidInput");
        }
        if (input.provider === "slack") {
          return beginSlackConfiguration(
            options,
            request,
            account,
            callbackOrigin,
            input,
            returnRoute,
          );
        }
        if (input.provider === "linear") {
          return beginLinearConfiguration(
            options,
            request,
            account,
            callbackOrigin,
            input,
            returnRoute,
          );
        }
        return verifyAndActivateProvider(options, account, provider, input, callbackOrigin);
      });
    },

    async beginConnection(request, provider, organizationId, surface) {
      rejectMutation(options, request);
      await requireOperator(options, request);
      const callbackOrigin = await safeCallbackOrigin(options, request);
      const integration = registry.get(provider);
      if (provider === "linear" || integration?.connection.requiresHttps === true) {
        requireHttpsOrigin(callbackOrigin);
      }
      return serialize(queues, provider, async () => {
        const stored = await options.store.read(provider);
        const envConfig = environmentConfigurationFor(options.environment, provider);
        const configuration = envConfig ?? stored?.configuration;
        if (configuration === undefined || options.beginCandidateConnection === undefined) {
          throw new ProviderApplicationError("invalidInput");
        }
        const configurationVersion = envConfig === undefined ? stored!.version : 0;
        const identity = options.runtime.identity?.(provider) ?? stored?.identity;
        if (identity === undefined) throw new ProviderApplicationError("invalidInput");
        let candidate: ProviderRuntimeCandidate | undefined;
        try {
          candidate = await options.runtime.prepare(
            provider,
            configuration,
            callbackOrigin,
            identity,
            configurationVersion,
          );
          if (candidate.beginConnection === undefined) {
            throw new Error("provider connection unavailable");
          }
          const result = await options.beginCandidateConnection(
            request,
            organizationId,
            providerApplicationReturnRoute(surface),
            (candidateRequest) => candidate!.beginConnection!(candidateRequest),
          );
          await candidate.close();
          return result;
        } catch (error) {
          await closeCandidate(candidate, provider, "begin_connection");
          if (error instanceof ProviderApplicationError) throw error;
          throw new ProviderApplicationError("internal", undefined, { cause: error });
        }
      });
    },
    async runSetupAction(request, provider, action, payload) {
      rejectMutation(options, request);
      const account = await requireOperator(options, request);
      const callbackOrigin = await safeCallbackOrigin(options, request);
      const integration = registry.get(provider);
      const handler = integration?.connection.setupActions?.[action];
      if (integration === undefined || handler === undefined || options.database === undefined) {
        throw new ProviderApplicationError("invalidInput");
      }
      const stored = await options.store.read(provider);
      const configuration =
        environmentConfigurationFor(options.environment, provider) ?? stored?.configuration;
      return handler({
        request,
        organizationId: account.session.activeOrganizationId,
        accountId: account.account.id,
        callbackOrigin,
        configuration,
        database: options.database,
        fetch: options.fetch ?? fetch,
        now: options.now ?? (() => new Date()),
        payload,
      });
    },
    async configureSlackSocket(request, input) {
      rejectMutation(options, request);
      const account = await requireOperator(options, request);
      if (options.environment.slack !== undefined) {
        throw new ProviderApplicationError("managedByEnvironment");
      }
      if (options.slackSocketVerifier === undefined) {
        throw new ProviderApplicationError("internal");
      }
      return serialize(queues, "slack", async () => {
        if (!input.appToken.startsWith("xapp-") || !input.botToken.startsWith("xoxb-")) {
          throw new ProviderApplicationError("invalidInput");
        }
        const organizationId = account.session.activeOrganizationId;
        if (organizationId === null) throw new ProviderApplicationError("invalidInput");
        let installation: Awaited<ReturnType<SlackSocketInstallationVerifier["verify"]>>;
        try {
          installation = await options.slackSocketVerifier!.verify(input.appToken, input.botToken);
        } catch (error) {
          if (error instanceof ProviderVerificationError) {
            throw new ProviderApplicationError(error.reason, error.subject, { cause: error });
          }
          throw new ProviderApplicationError("internal", undefined, { cause: error });
        }
        const configuration = {
          provider: "slack" as const,
          transport: "socket" as const,
          appId: installation.appId,
          appToken: input.appToken,
        };
        const identity = {
          provider: "slack" as const,
          id: installation.appId,
          name: installation.appId,
        };
        let candidate: ProviderRuntimeCandidate | undefined;
        try {
          candidate = await options.runtime.prepare(
            "slack",
            configuration,
            await safeCallbackOrigin(options, request),
            identity,
            (input.expectedVersion ?? 0) + 1,
          );
          await candidate.start();
          const saved = await options.store.completeSlackSocketApplication({
            configuration,
            identity,
            expectedVersion: input.expectedVersion,
            updatedByUserId: account.account.id,
            organizationId,
            installation,
          });
          candidate.publish();
          candidate = undefined;
          return {
            status: "verified",
            provider: "slack",
            identity,
            configurationVersion: saved.version,
          };
        } catch (error) {
          await closeCandidate(candidate, "slack", "configure_socket");
          if (isConfigurationConflict(error)) {
            throw new ProviderApplicationError("configurationConflict");
          }
          if (isIdentityConflict(error)) {
            throw new ProviderApplicationError("identityConflict");
          }
          if (error instanceof ProviderApplicationError) throw error;
          throw new ProviderApplicationError("internal", undefined, { cause: error });
        }
      });
    },
    async retrySlackSocket(request) {
      rejectMutation(options, request);
      await requireOperator(options, request);
      if (options.slackDelivery === undefined) {
        throw new ProviderApplicationError("invalidInput");
      }
      await options.slackDelivery.retry();
    },
  };
}

function rejectMutation(options: ProviderApplicationsOptions, request: Request): void {
  if (request.method !== "POST") throw new ProviderApplicationError("forbidden");
  if (options.auth.rejectCookieMutation(request) !== undefined) {
    throw new ProviderApplicationError("forbidden");
  }
}

async function requireOperator(
  options: ProviderApplicationsOptions,
  request: Request,
): Promise<AccountAccessValue> {
  let account: AccountAccessValue;
  try {
    account = await options.auth.resolveAccount(request);
  } catch (error) {
    throw new ProviderApplicationError("forbidden", undefined, { cause: error });
  }
  if (!account.isInstanceOperator) throw new ProviderApplicationError("forbidden");
  return account;
}

async function safeCallbackOrigin(
  options: ProviderApplicationsOptions,
  request: Request,
): Promise<string> {
  try {
    return await options.callbackOrigin(request);
  } catch (error) {
    throw new ProviderApplicationError("invalidOrigin", undefined, { cause: error });
  }
}

function serialize<T>(
  queues: Map<ApplicationProvider, Promise<void>>,
  provider: ApplicationProvider,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(provider) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(provider, settled);
  void settled.finally(() => {
    if (queues.get(provider) === settled) queues.delete(provider);
  });
  return result;
}

function providerStatus(
  environmentManaged: boolean,
  identity: AnyProviderApplicationIdentity | null,
  connections: readonly ConnectedProviderIdentity[],
): ProviderApplicationStatus {
  if (environmentManaged) return "managedByEnvironment";
  if (connections.some((connection) => connection.status === "actionNeeded")) return "actionNeeded";
  if (connections.length > 0) return "connected";
  return identity === null ? "notConfigured" : "verified";
}

/**
 * GitHub admits a delivery only when it can check the signature, so an App saved without a
 * webhook secret has repository access and no event triggers. Slack and Linear signing secrets
 * are part of their credentials, and Discord never delivers anything here.
 */
function acceptsEvents(
  configuration: AnyProviderApplicationConfiguration | undefined,
  registry: IntegrationRegistry = defaultIntegrationRegistry,
): boolean {
  if (configuration === undefined) return false;
  if (isLegacyProviderApplicationConfiguration(configuration)) {
    if (configuration.provider === "github") {
      return configuration.webhookSecret !== undefined && configuration.webhookSecret !== "";
    }
    return configuration.provider === "slack" || configuration.provider === "linear";
  }
  const integration = registry.get(configuration.provider);
  return integration === undefined ? false : integration.connection.acceptsEvents(configuration);
}

function publicIdentifiers(
  configuration: AnyProviderApplicationConfiguration,
  registry: IntegrationRegistry = defaultIntegrationRegistry,
): Readonly<Record<string, string>> {
  if (isLegacyProviderApplicationConfiguration(configuration)) {
    switch (configuration.provider) {
      case "github":
        return {
          appId: configuration.appId,
          appSlug: configuration.appSlug,
          clientId: configuration.clientId,
        };
      case "slack":
        return configuration.transport === "webhook"
          ? {
              appId: configuration.appId,
              transport: configuration.transport,
              clientId: configuration.clientId,
            }
          : { appId: configuration.appId, transport: configuration.transport };
      case "discord":
        return { applicationId: configuration.applicationId };
      case "linear":
        return { clientId: configuration.clientId };
    }
  }
  const integration = registry.get(configuration.provider);
  if (integration !== undefined) return integration.connection.publicIdentifiers(configuration);
  throw new Error("unknown provider configuration");
}

function withoutExpectedVersion<T extends AnyProviderApplicationConfiguration>(input: T): T {
  const { expectedVersion: _expectedVersion, ...configuration } = input;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return configuration as T;
}

function sameExternalIdentity(
  left: AnyProviderApplicationIdentity,
  right: AnyProviderApplicationIdentity,
): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function identityConflictsWithConnections(
  identity: AnyProviderApplicationIdentity,
  previous: StoredProviderApplication | undefined,
  connections: readonly ConnectedProviderIdentity[],
): boolean {
  if (connections.length === 0) return false;
  if (
    connections.some(
      (connection) => connection.applicationId !== null && connection.applicationId !== identity.id,
    )
  ) {
    return true;
  }
  return (
    connections.some((connection) => connection.applicationId === null) &&
    (previous === undefined || !sameExternalIdentity(previous.identity, identity))
  );
}

function isConfigurationConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    Reflect.get(error, "name") === "ProviderConfigurationConflictError"
  );
}

function isIdentityConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    Reflect.get(error, "name") === "ProviderApplicationIdentityConflictError"
  );
}

export { TRUSTED_REQUEST_ORIGIN_HEADER } from "../http/request-origin.js";

export function resolveCallbackOrigin(request: Request, explicitAppUrl?: string): string {
  const browserValue = request.headers.get("origin") ?? request.headers.get("referer");
  if (browserValue === null || browserValue === "null") throw new Error("invalid browser origin");
  const browserOrigin = parseHttpOrigin(browserValue);
  const expectedOrigin =
    explicitAppUrl === undefined
      ? request.headers.get(TRUSTED_REQUEST_ORIGIN_HEADER)
      : parseHttpOrigin(explicitAppUrl);
  if (expectedOrigin === null || parseHttpOrigin(expectedOrigin) !== browserOrigin) {
    throw new Error("browser origin does not match trusted request origin");
  }
  return browserOrigin;
}

export { createProviderApplicationStore } from "./internal/store.js";
export { parseProviderApplicationConfiguration } from "./internal/store.js";
export { readProviderApplicationEnvironment } from "./internal/environment.js";
export { createProviderApplicationVerifier } from "./internal/verifier.js";
export { DynamicProviderRuntime } from "./internal/runtime-owner.js";
export { createProviderApplicationInventory } from "./internal/inventory.js";

export async function activateProviderApplicationsAtStartup(options: {
  store: ProviderApplicationStore;
  environment: ProviderApplicationEnvironment;
  runtime: ProviderRuntimeOwner;
  verifier: ProviderApplicationVerifier;
  inventory: ProviderApplicationInventory;
  callbackOrigin: string;
  registry?: IntegrationRegistry;
  logger?: Pick<typeof logger, "info" | "error">;
}): Promise<readonly { provider: ApplicationProvider; error: unknown }[]> {
  const registry = options.registry ?? defaultIntegrationRegistry;
  const failures: { provider: ApplicationProvider; error: unknown }[] = [];
  const storedProviders = new Map(
    (await options.store.readAll()).map((configuration) => [configuration.provider, configuration]),
  );
  const providerIds: readonly ApplicationProvider[] = [...PROVIDERS, ...registry.ids()];
  for (const provider of providerIds) {
    const environmentConfiguration = environmentConfigurationFor(options.environment, provider);
    const stored = storedProviders.get(provider);
    const configuration = environmentConfiguration ?? stored?.configuration;
    if (configuration === undefined) continue;
    const scrubValues = sensitiveConfigurationValues(configuration, registry);
    const phase = <T>(
      name: "identity" | "inventory" | "prepare" | "start" | "activate" | "cleanup",
      run: () => Promise<T>,
    ) => logStartupPhase(options.logger ?? logger, provider, name, scrubValues, run);

    let candidate: ProviderRuntimeCandidate | undefined;
    try {
      const identity = await phase("identity", () =>
        startupIdentity(
          provider,
          environmentConfiguration,
          stored,
          options.verifier,
          registry,
          options.callbackOrigin,
        ),
      );
      const claimLegacyConnections = await phase("inventory", async () => {
        const connections = await options.inventory.connectedIdentities(provider);
        const claim =
          stored === undefined &&
          connections.length > 0 &&
          connections.every((connection) => connection.applicationId === null);
        if (identityConflictsWithConnections(identity, stored, connections) && !claim) {
          throw new ProviderApplicationError("identityConflict", stored?.identity.name);
        }
        return claim;
      });
      const configurationVersion = environmentConfiguration === undefined ? stored!.version : 0;
      const prepared = await phase("prepare", () =>
        options.runtime.prepare(
          provider,
          configuration,
          options.callbackOrigin,
          identity,
          configurationVersion,
        ),
      );
      candidate = prepared;
      await phase("start", () => prepared.start());
      await phase("activate", async () => {
        if (
          claimLegacyConnections &&
          !(await options.inventory.claimLegacyConnections(provider, identity))
        ) {
          throw new ProviderApplicationError("identityConflict");
        }
        await options.store.activate({ provider, identity, configurationVersion });
        prepared.publish();
      });
    } catch (error) {
      failures.push({ provider, error });
      if (candidate !== undefined) {
        const failedCandidate = candidate;
        await phase("cleanup", () => failedCandidate.close()).catch(() => {});
      }
    }
  }
  return failures;
}

async function logStartupPhase<T>(
  log: Pick<typeof logger, "info" | "error">,
  provider: ApplicationProvider,
  phase: string,
  scrubValues: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const operation = "provider_application.activate_at_startup";
  const context = { operation, provider, phase };
  const started = performance.now();
  log.info({ ...context, durationMs: 0, outcome: "started" }, "provider startup phase started");
  try {
    const result = await run();
    log.info(
      { ...context, durationMs: Math.round(performance.now() - started), outcome: "succeeded" },
      "provider startup phase finished",
    );
    return result;
  } catch (error) {
    log.error(
      {
        ...context,
        durationMs: Math.round(performance.now() - started),
        outcome: "failed",
        failureKind: classifyFailure(error),
        err: error instanceof Error ? errorForLog(error, { scrubValues }) : undefined,
      },
      "provider startup phase failed",
    );
    throw error;
  }
}

async function startupIdentity(
  provider: ApplicationProvider,
  environmentConfiguration: AnyProviderApplicationConfiguration | undefined,
  stored: StoredProviderApplication | undefined,
  verifier: ProviderApplicationVerifier,
  registry: IntegrationRegistry = defaultIntegrationRegistry,
  callbackOrigin?: string,
): Promise<AnyProviderApplicationIdentity> {
  if (environmentConfiguration === undefined) {
    if (stored === undefined) throw new Error("stored provider application unavailable");
    return stored.identity;
  }
  const verifyContext = callbackOrigin === undefined ? undefined : { callbackOrigin };
  if (
    isLegacyProvider(provider) &&
    isLegacyProviderApplicationConfiguration(environmentConfiguration)
  ) {
    if (environmentConfiguration.provider === "slack") {
      return {
        provider: "slack",
        id: environmentConfiguration.appId,
        name: "Slack app",
      };
    }
    if (environmentConfiguration.provider === "linear") {
      return {
        provider: "linear",
        id: environmentConfiguration.clientId,
        name: "Linear app",
      };
    }
    return verifier.verify(provider, environmentConfiguration, verifyContext);
  }
  const integration = registry.get(provider);
  if (integration !== undefined) {
    if (integration.connection.verifyDirect !== undefined) {
      const verified = await verifier.verifyDirect?.(
        provider,
        environmentConfiguration,
        verifyContext,
      );
      if (verified !== undefined) return verified.identity;
    }
    const oauthIdentity = integration.connection.oauthAppIdentity?.(environmentConfiguration);
    if (oauthIdentity !== undefined) return oauthIdentity;
  }
  throw new ProviderVerificationError("credentialsRejected");
}

function parseHttpOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid origin");
  if (url.username !== "" || url.password !== "") throw new Error("invalid origin");
  return url.origin;
}

function requireHttpsOrigin(callbackOrigin: string): void {
  if (!callbackOrigin.startsWith("https://")) {
    throw new ProviderApplicationError("httpsRequired", callbackOrigin);
  }
}

async function beginSlackConfiguration(
  options: ProviderApplicationsOptions,
  request: Request,
  account: AccountAccessValue,
  callbackOrigin: string,
  input: SlackProviderApplicationConfiguration,
  returnRoute: string,
): Promise<ProviderApplicationContinuation> {
  requireHttpsOrigin(callbackOrigin);
  const previous = await options.store.read("slack");
  if (previous?.version !== input.expectedVersion) {
    throw new ProviderApplicationError("configurationConflict");
  }
  const organizationId = account.session.activeOrganizationId;
  if (organizationId === null || options.beginCandidateConnection === undefined) {
    throw new ProviderApplicationError("invalidInput");
  }
  const candidate = await options.runtime.prepare(
    "slack",
    withoutExpectedVersion(input),
    callbackOrigin,
    { provider: "slack", id: input.appId, name: input.appId },
    (input.expectedVersion ?? 0) + 1,
    {
      expectedConfigurationVersion: input.expectedVersion,
      activateConfiguration: true,
    },
  );
  if (candidate.beginConnection === undefined) {
    await closeCandidate(candidate, "slack", "begin_configuration");
    throw new ProviderApplicationError("internal");
  }
  try {
    const { url } = await options.beginCandidateConnection(
      request,
      organizationId,
      returnRoute,
      (candidateRequest) => {
        const result = candidate.beginConnection?.(candidateRequest);
        return result ?? Promise.reject(new Error("provider unavailable"));
      },
    );
    await candidate.close();
    return { status: "continuing", provider: "slack", url };
  } catch (error) {
    await closeCandidate(candidate, "slack", "begin_configuration");
    if (error instanceof ProviderApplicationError) throw error;
    throw new ProviderApplicationError("internal", undefined, { cause: error });
  }
}

/**
 * Linear cannot verify an OAuth client's secret without an authorization grant. Treat saving
 * credentials as a candidate connection: the callback verifies the grant, persists the app and
 * workspace binding atomically, then publishes the prepared runtime.
 */
async function beginLinearConfiguration(
  options: ProviderApplicationsOptions,
  request: Request,
  account: AccountAccessValue,
  callbackOrigin: string,
  input: LinearProviderApplicationConfiguration,
  returnRoute: string,
): Promise<ProviderApplicationContinuation> {
  requireHttpsOrigin(callbackOrigin);
  const previous = await options.store.read("linear");
  if (previous?.version !== input.expectedVersion) {
    throw new ProviderApplicationError("configurationConflict");
  }
  const organizationId = account.session.activeOrganizationId;
  if (organizationId === null || options.beginCandidateConnection === undefined) {
    throw new ProviderApplicationError("invalidInput");
  }
  const candidate = await options.runtime.prepare(
    "linear",
    withoutExpectedVersion(input),
    callbackOrigin,
    { provider: "linear", id: input.clientId, name: "Linear app" },
    (input.expectedVersion ?? 0) + 1,
    {
      expectedConfigurationVersion: input.expectedVersion,
      activateConfiguration: true,
    },
  );
  if (candidate.beginConnection === undefined) {
    await closeCandidate(candidate, "linear", "begin_configuration");
    throw new ProviderApplicationError("internal");
  }
  try {
    const { url } = await options.beginCandidateConnection(
      request,
      organizationId,
      returnRoute,
      (candidateRequest) => {
        const result = candidate.beginConnection?.(candidateRequest);
        return result ?? Promise.reject(new Error("provider unavailable"));
      },
    );
    await candidate.close();
    return { status: "continuing", provider: "linear", url };
  } catch (error) {
    await closeCandidate(candidate, "linear", "begin_configuration");
    if (error instanceof ProviderApplicationError) throw error;
    throw new ProviderApplicationError("internal", undefined, { cause: error });
  }
}

async function verifyDirectIntegration(
  options: ProviderApplicationsOptions,
  integration: IntegrationDefinition,
  configuration: AnyProviderApplicationConfiguration,
  callbackOrigin: string,
): Promise<
  | {
      readonly identity: IntegrationAppIdentity;
      readonly initialConnection?: BindIntegrationConnectionPayload;
    }
  | undefined
> {
  if (integration.connection.verifyDirect === undefined) return undefined;
  try {
    return options.verifier.verifyDirect !== undefined
      ? await options.verifier.verifyDirect(integration.id, configuration, { callbackOrigin })
      : await integration.connection.verifyDirect(configuration, {
          fetch: options.fetch ?? fetch,
          callbackOrigin,
          now: options.now ?? (() => new Date()),
        });
  } catch (error) {
    if (error instanceof ProviderVerificationError) {
      throw new ProviderApplicationError(error.reason, error.subject, { cause: error });
    }
    throw new ProviderApplicationError("internal", undefined, { cause: error });
  }
}

async function saveRegisteredIntegration(
  options: ProviderApplicationsOptions,
  integration: IntegrationDefinition,
  request: Request,
  account: AccountAccessValue,
  callbackOrigin: string,
  input: AnyProviderApplicationConfiguration,
  returnRoute: string,
): Promise<ProviderApplicationSaveResult> {
  const stripped = withoutExpectedVersion(input);
  const parsedConfig = integration.connection.configSchema.safeParse(stripped);
  if (
    !parsedConfig.success ||
    typeof parsedConfig.data !== "object" ||
    parsedConfig.data === null
  ) {
    throw new ProviderApplicationError("invalidInput");
  }
  const configuration: RegisteredProviderApplicationConfiguration = {
    ...Object.fromEntries(Object.entries(parsedConfig.data)),
    provider: integration.id,
  };
  if (integration.connection.requiresHttps === true) {
    requireHttpsOrigin(callbackOrigin);
  }
  const directResult = await verifyDirectIntegration(
    options,
    integration,
    configuration,
    callbackOrigin,
  );
  if (directResult === undefined) {
    return beginIntegrationConfiguration(
      options,
      integration,
      request,
      account,
      callbackOrigin,
      configuration,
      input.expectedVersion,
      returnRoute,
    );
  }
  const { identity, initialConnection } = directResult;
  if (identity.provider !== integration.id) {
    throw new ProviderApplicationError("credentialsRejected");
  }
  const previous = await options.store.read(integration.id);
  const connections = await options.inventory.connectedIdentities(integration.id);
  if (identityConflictsWithConnections(identity, previous, connections)) {
    throw new ProviderApplicationError("identityConflict", previous?.identity.name);
  }
  let candidate: ProviderRuntimeCandidate | undefined;
  try {
    candidate = await options.runtime.prepare(
      integration.id,
      configuration,
      callbackOrigin,
      identity,
      (input.expectedVersion ?? 0) + 1,
    );
    await candidate.start();
    const saved =
      initialConnection !== undefined
        ? await saveDirectIntegrationWithConnection(
            options,
            account,
            integration.id,
            configuration,
            identity,
            input.expectedVersion,
            initialConnection,
          )
        : await options.store.save({
            provider: integration.id,
            configuration,
            identity,
            expectedVersion: input.expectedVersion,
            updatedByUserId: account.account.id,
          });
    candidate.publish();
    candidate = undefined;
    return {
      status: "verified",
      provider: integration.id,
      identity,
      configurationVersion: saved.version,
    };
  } catch (error) {
    await closeCandidate(candidate, integration.id, "verify_and_save");
    throw mapSaveError(error, previous?.identity.name);
  }
}

function mapSaveError(error: unknown, previousName: string | undefined): ProviderApplicationError {
  if (error instanceof ProviderApplicationError) return error;
  if (isIdentityConflict(error))
    return new ProviderApplicationError("identityConflict", previousName);
  if (isConfigurationConflict(error)) return new ProviderApplicationError("configurationConflict");
  return new ProviderApplicationError("internal", undefined, { cause: error });
}

async function saveDirectIntegrationWithConnection(
  options: ProviderApplicationsOptions,
  account: AccountAccessValue,
  provider: string,
  configuration: AnyProviderApplicationConfiguration,
  identity: IntegrationAppIdentity,
  expectedVersion: number | undefined,
  connection: BindIntegrationConnectionPayload,
): Promise<StoredProviderApplication> {
  const organizationId = account.session.activeOrganizationId;
  if (organizationId === null || options.store.completeDirectIntegrationApplication === undefined) {
    throw new ProviderApplicationError("invalidInput");
  }
  return options.store.completeDirectIntegrationApplication({
    provider,
    configuration,
    identity,
    expectedVersion,
    updatedByUserId: account.account.id,
    organizationId,
    connection,
  });
}

async function beginIntegrationConfiguration(
  options: ProviderApplicationsOptions,
  integration: IntegrationDefinition,
  request: Request,
  account: AccountAccessValue,
  callbackOrigin: string,
  configuration: AnyProviderApplicationConfiguration,
  expectedVersion: number | undefined,
  returnRoute: string,
): Promise<ProviderApplicationContinuation> {
  const previous = await options.store.read(integration.id);
  if (previous?.version !== expectedVersion) {
    throw new ProviderApplicationError("configurationConflict");
  }
  const organizationId = account.session.activeOrganizationId;
  if (organizationId === null || options.beginCandidateConnection === undefined) {
    throw new ProviderApplicationError("invalidInput");
  }
  const identity = integration.connection.oauthAppIdentity?.(configuration) ?? {
    provider: integration.id,
    id: integration.id,
    name: integration.label,
  };
  const candidate = await options.runtime.prepare(
    integration.id,
    configuration,
    callbackOrigin,
    identity,
    (expectedVersion ?? 0) + 1,
    {
      expectedConfigurationVersion: expectedVersion,
      activateConfiguration: true,
    },
  );
  if (candidate.beginConnection === undefined) {
    await closeCandidate(candidate, integration.id, "begin_configuration");
    throw new ProviderApplicationError("internal");
  }
  try {
    const { url } = await options.beginCandidateConnection(
      request,
      organizationId,
      returnRoute,
      (candidateRequest) => {
        const result = candidate.beginConnection?.(candidateRequest);
        return result ?? Promise.reject(new Error("provider unavailable"));
      },
    );
    await candidate.close();
    return { status: "continuing", provider: integration.id, url };
  } catch (error) {
    await closeCandidate(candidate, integration.id, "begin_configuration");
    if (error instanceof ProviderApplicationError) throw error;
    throw new ProviderApplicationError("internal", undefined, { cause: error });
  }
}

async function completeIntegrationInstallation(
  options: ProviderApplicationsOptions,
  registry: IntegrationRegistry,
  input: IntegrationOAuthCompletionInput,
): Promise<void> {
  const integration = registry.get(input.provider);
  if (integration === undefined || options.store.completeIntegrationInstallation === undefined) {
    throw new ProviderApplicationError("internal");
  }
  const configuration = parseProviderApplicationConfiguration(input.configuration, registry);
  if (configuration.provider !== input.provider) {
    throw new ProviderApplicationError("credentialsRejected");
  }
  const previous = await options.store.read(input.provider);
  const connections = await options.inventory.connectedIdentities(input.provider);
  if (identityConflictsWithConnections(input.identity, previous, connections)) {
    throw new ProviderApplicationError("identityConflict", previous?.identity.name);
  }
  let candidate: ProviderRuntimeCandidate | undefined;
  try {
    candidate = await options.runtime.prepare(
      input.provider,
      configuration,
      input.callbackOrigin,
      input.identity,
      (input.expectedConfigurationVersion ?? 0) + 1,
    );
    await candidate.start();
    await options.store.completeIntegrationInstallation({
      provider: input.provider,
      configuration,
      identity: input.identity,
      expectedVersion: input.expectedConfigurationVersion,
      updatedByUserId: input.userId,
      attempt: input.attempt,
      connection: input.connection,
    });
    candidate.publish();
    candidate = undefined;
  } catch (error) {
    await closeCandidate(candidate, input.provider, "complete_installation");
    throw error;
  }
}

async function verifyAndActivateProvider(
  options: ProviderApplicationsOptions,
  account: AccountAccessValue,
  provider: Provider,
  input: ProviderApplicationConfiguration,
  callbackOrigin: string,
): Promise<ProviderApplicationResult> {
  let identity: AnyProviderApplicationIdentity;
  try {
    identity = await options.verifier.verify(provider, input, { callbackOrigin });
  } catch (error) {
    if (error instanceof ProviderVerificationError) {
      // The subject travels as safe context so the copy can name the field the provider
      // objected to instead of sending the operator back over all of them.
      throw new ProviderApplicationError(error.reason, error.subject, { cause: error });
    }
    throw new ProviderApplicationError("internal", undefined, { cause: error });
  }
  if (identity.provider !== provider) throw new ProviderApplicationError("credentialsRejected");
  const previous = await options.store.read(provider);
  const connections = await options.inventory.connectedIdentities(provider);
  if (identityConflictsWithConnections(identity, previous, connections)) {
    throw new ProviderApplicationError("identityConflict", previous?.identity.name);
  }
  let candidate: ProviderRuntimeCandidate | undefined;
  try {
    candidate = await options.runtime.prepare(
      provider,
      withoutExpectedVersion(input),
      callbackOrigin,
      identity,
      (input.expectedVersion ?? 0) + 1,
    );
    await candidate.start().catch((error: unknown) => {
      if (provider === "discord" && classifyFailure(error) === "timeout") {
        throw new ProviderApplicationError("timeout", undefined, { cause: error });
      }
      throw error;
    });
    const saved = await options.store.save({
      provider,
      configuration: withoutExpectedVersion(input),
      identity,
      expectedVersion: input.expectedVersion,
      updatedByUserId: account.account.id,
    });
    candidate.publish();
    candidate = undefined;
    return { status: "verified", provider, identity, configurationVersion: saved.version };
  } catch (error) {
    await closeCandidate(candidate, provider, "verify_and_save");
    if (error instanceof ProviderApplicationError) throw error;
    const gateway = provider === "discord" ? discordGatewayFailure(error) : undefined;
    if (gateway !== undefined) {
      throw new ProviderApplicationError(gateway.code, discordGatewayContext(gateway.failure), {
        cause: error,
      });
    }
    if (isIdentityConflict(error)) {
      throw new ProviderApplicationError("identityConflict", previous?.identity.name);
    }
    if (isConfigurationConflict(error)) {
      throw new ProviderApplicationError("configurationConflict");
    }
    throw new ProviderApplicationError("internal", undefined, { cause: error });
  }
}

function discordGatewayContext(failure: string): string {
  return `discordGateway${failure[0]?.toUpperCase()}${failure.slice(1)}`;
}

function discordGatewayFailure(error: unknown):
  | {
      code: "credentialsRejected" | "permissionMissing" | "internal";
      failure: string;
    }
  | undefined {
  if (!(error instanceof Error) || error.name !== "DiscordGatewayError") return undefined;
  const code: unknown = Reflect.get(error, "code");
  const failure: unknown = Reflect.get(error, "gatewayFailure");
  if (
    (code !== "credentialsRejected" && code !== "permissionMissing" && code !== "internal") ||
    typeof failure !== "string"
  ) {
    return undefined;
  }
  return { code, failure };
}

async function completeSlackInstallation(
  options: ProviderApplicationsOptions,
  input: {
    configuration: unknown;
    expectedConfigurationVersion: number | undefined;
    callbackOrigin: string;
    userId: string;
    installation: VerifiedSlackInstallation;
    binding: BindSlackConnectionInput;
  },
): Promise<void> {
  const configuration = parseProviderApplicationConfiguration(input.configuration);
  if (
    !isLegacyProviderApplicationConfiguration(configuration) ||
    configuration.provider !== "slack" ||
    configuration.appId !== input.installation.appId
  ) {
    throw new ProviderApplicationError("credentialsRejected");
  }
  const previous = await options.store.read("slack");
  const connections = await options.inventory.connectedIdentities("slack");
  const identity: ProviderApplicationIdentity = {
    provider: "slack",
    id: input.installation.appId,
    name: input.installation.appId,
  };
  if (identityConflictsWithConnections(identity, previous, connections)) {
    throw new ProviderApplicationError("identityConflict", previous?.identity.name);
  }
  let candidate: ProviderRuntimeCandidate | undefined;
  try {
    candidate = await options.runtime.prepare(
      "slack",
      configuration,
      input.callbackOrigin,
      identity,
      (input.expectedConfigurationVersion ?? 0) + 1,
    );
    await candidate.start();
    await options.store.completeSlackInstallation({
      configuration,
      identity,
      expectedVersion: input.expectedConfigurationVersion,
      updatedByUserId: input.userId,
      binding: input.binding,
    });
    candidate.publish();
    candidate = undefined;
  } catch (error) {
    await closeCandidate(candidate, "slack", "complete_installation");
    throw error;
  }
}

async function completeLinearInstallation(
  options: ProviderApplicationsOptions,
  input: {
    configuration: unknown;
    expectedConfigurationVersion: number | undefined;
    callbackOrigin: string;
    userId: string;
    installation: LinearInstallation;
    binding: BindLinearConnectionInput;
  },
): Promise<void> {
  const configuration = parseProviderApplicationConfiguration(input.configuration);
  if (
    !isLegacyProviderApplicationConfiguration(configuration) ||
    configuration.provider !== "linear" ||
    configuration.clientId !== input.binding.providerApplicationId
  ) {
    throw new ProviderApplicationError("credentialsRejected");
  }
  const previous = await options.store.read("linear");
  const connections = await options.inventory.connectedIdentities("linear");
  const identity: ProviderApplicationIdentity = {
    provider: "linear",
    id: configuration.clientId,
    name: "Linear app",
  };
  if (identityConflictsWithConnections(identity, previous, connections)) {
    throw new ProviderApplicationError("identityConflict", previous?.identity.name);
  }
  let candidate: ProviderRuntimeCandidate | undefined;
  try {
    candidate = await options.runtime.prepare(
      "linear",
      configuration,
      input.callbackOrigin,
      identity,
      (input.expectedConfigurationVersion ?? 0) + 1,
    );
    await candidate.start();
    await options.store.completeLinearInstallation({
      configuration,
      identity,
      expectedVersion: input.expectedConfigurationVersion,
      updatedByUserId: input.userId,
      installation: input.installation,
      binding: input.binding,
    });
    candidate.publish();
    candidate = undefined;
  } catch (error) {
    await closeCandidate(candidate, "linear", "complete_installation");
    throw error;
  }
}

async function closeCandidate(
  candidate: ProviderRuntimeCandidate | undefined,
  provider: ApplicationProvider,
  parentOperation: string,
): Promise<void> {
  if (candidate === undefined) return;
  try {
    await candidate.close();
  } catch (error) {
    reportFailure(error, {
      operation: `provider_application.${parentOperation}.cleanup`,
      component: "provider_applications",
      provider,
    });
  }
}
