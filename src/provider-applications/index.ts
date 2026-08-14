import type { AccountAccessValue } from "../auth/organization-access.js";
import { TRUSTED_REQUEST_ORIGIN_HEADER } from "../http/request-origin.js";
import { parseProviderApplicationConfiguration } from "./internal/store.js";

export const PROVIDERS = ["github", "slack", "discord"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface GitHubProviderApplicationConfiguration {
  provider: "github";
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
  expectedVersion?: number;
}

export interface SlackProviderApplicationConfiguration {
  provider: "slack";
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  expectedVersion?: number;
}

export interface DiscordProviderApplicationConfiguration {
  provider: "discord";
  applicationId: string;
  clientSecret: string;
  botToken: string;
  expectedVersion?: number;
}

export type ProviderApplicationConfiguration =
  | GitHubProviderApplicationConfiguration
  | SlackProviderApplicationConfiguration
  | DiscordProviderApplicationConfiguration;

export type ProviderApplicationIdentity =
  | { provider: "github"; id: string; name: string; ownerLogin: string }
  | { provider: "slack"; id: string; name: string }
  | { provider: "discord"; id: string; name: string };

export interface StoredProviderApplication {
  provider: Provider;
  configuration: ProviderApplicationConfiguration;
  identity: ProviderApplicationIdentity;
  version: number;
  verifiedAt: Date;
  updatedAt: Date;
  updatedByUserId: string | null;
}

export interface ProviderApplicationStore {
  read(provider: Provider): Promise<StoredProviderApplication | undefined>;
  readAll(): Promise<readonly StoredProviderApplication[]>;
  save(input: {
    provider: Provider;
    configuration: ProviderApplicationConfiguration;
    identity: ProviderApplicationIdentity;
    expectedVersion: number | undefined;
    updatedByUserId: string;
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
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
    callbackOrigin: string,
    identity: ProviderApplicationIdentity,
    configurationVersion: number,
    activation?: {
      expectedConfigurationVersion: number | undefined;
      activateConfiguration: boolean;
    },
  ): Promise<ProviderRuntimeCandidate>;
  identity?(provider: Provider): ProviderApplicationIdentity | undefined;
  onSlackInstallation?(
    handler: (input: {
      configuration: unknown;
      expectedConfigurationVersion: number | undefined;
      callbackOrigin: string;
      userId: string;
      installation: VerifiedSlackInstallation;
    }) => Promise<void>,
  ): void;
}

export interface ProviderApplicationVerifier {
  verify(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
  ): Promise<ProviderApplicationIdentity>;
}

export interface ConnectedProviderIdentity {
  id: string;
  name: string;
  status: "connected" | "actionNeeded";
}

export interface ProviderApplicationInventory {
  connectedIdentities(provider: Provider): Promise<readonly ConnectedProviderIdentity[]>;
  lastEventAt(provider: Provider): Promise<Date | null>;
}

export type ProviderApplicationStatus =
  | "notConfigured"
  | "verified"
  | "connected"
  | "actionNeeded"
  | "managedByEnvironment";

export interface ProviderApplicationView {
  provider: Provider;
  status: ProviderApplicationStatus;
  managedByEnvironment: boolean;
  identifiers: Readonly<Record<string, string>>;
  identity: ProviderApplicationIdentity | null;
  connections: readonly ConnectedProviderIdentity[];
  lastEventAt: string | null;
  replaceable: boolean;
  configurationVersion: number | null;
}

export interface ProviderApplicationOverview {
  callbackOrigin: string;
  providers: Record<Provider, ProviderApplicationView>;
}

export interface ProviderApplicationResult {
  status: "verified";
  provider: Provider;
  identity: ProviderApplicationIdentity;
  configurationVersion: number;
}

export interface ProviderApplicationContinuation {
  status: "continuing";
  provider: "slack";
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
}

export type ProviderApplicationErrorCode =
  | "forbidden"
  | "invalidOrigin"
  | "invalidInput"
  | "credentialsRejected"
  | "unreachable"
  | "identityConflict"
  | "configurationConflict"
  | "managedByEnvironment"
  | "httpsRequired";

export class ProviderApplicationError extends Error {
  constructor(
    readonly code: ProviderApplicationErrorCode,
    readonly safeContext?: string,
  ) {
    super(code);
    this.name = "ProviderApplicationError";
  }
}

export class ProviderVerificationError extends Error {
  constructor(readonly reason: "credentialsRejected" | "unreachable") {
    super(reason);
    this.name = "ProviderVerificationError";
  }
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
    provider: Provider,
    input: ProviderApplicationConfiguration,
    surface?: ProviderApplicationSurface,
  ): Promise<ProviderApplicationSaveResult>;
  beginConnection(
    request: Request,
    provider: Provider,
    organizationId: string,
    surface?: ProviderApplicationSurface,
  ): Promise<{ url: string }>;
}

interface ProviderApplicationsOptions {
  auth: {
    resolveAccount(request: Request): Promise<AccountAccessValue>;
    rejectCookieMutation(request: Request): Response | undefined;
  };
  store: ProviderApplicationStore;
  environment: Partial<Record<Provider, ProviderApplicationConfiguration>>;
  runtime: ProviderRuntimeOwner;
  verifier: ProviderApplicationVerifier;
  inventory: ProviderApplicationInventory;
  callbackOrigin(request: Request): string | Promise<string>;
  beginCandidateConnection?: (
    request: Request,
    organizationId: string,
    returnRoute: string,
    begin: (request: Request) => Promise<{ url: string }>,
  ) => Promise<{ url: string }>;
}

export function createProviderApplications(
  options: ProviderApplicationsOptions,
): ProviderApplications {
  const queues = new Map<Provider, Promise<void>>();
  options.runtime.onSlackInstallation?.((input) =>
    serialize(queues, "slack", () => completeSlackInstallation(options, input)),
  );

  return {
    async overview(request) {
      await requireOperator(options, request);
      const callbackOrigin = await safeCallbackOrigin(options, request);
      const stored = new Map(
        (await options.store.readAll()).map((value) => [value.provider, value]),
      );
      const entries = await Promise.all(
        PROVIDERS.map(async (provider) => {
          const environment = options.environment[provider];
          const persisted = stored.get(provider);
          const resolved = environment ?? persisted?.configuration;
          const connections = await options.inventory.connectedIdentities(provider);
          const identity = options.runtime.identity?.(provider) ?? persisted?.identity ?? null;
          const status = providerStatus(environment !== undefined, identity, connections);
          const view: ProviderApplicationView = {
            provider,
            status,
            managedByEnvironment: environment !== undefined,
            identifiers: resolved === undefined ? {} : publicIdentifiers(resolved),
            identity,
            connections,
            lastEventAt:
              provider === "discord"
                ? null
                : ((await options.inventory.lastEventAt(provider))?.toISOString() ?? null),
            replaceable: connections.length === 0,
            configurationVersion: environment === undefined ? (persisted?.version ?? null) : 0,
          };
          return [provider, view] as const;
        }),
      );
      const [github, slack, discord] = entries.map(([, view]) => view);
      if (github === undefined || slack === undefined || discord === undefined) {
        throw new Error("provider overview is incomplete");
      }
      return { callbackOrigin, providers: { github, slack, discord } };
    },

    async verifyAndSave(request, provider, input, surface) {
      rejectMutation(options, request);
      const account = await requireOperator(options, request);
      const callbackOrigin = await safeCallbackOrigin(options, request);
      if (options.environment[provider] !== undefined) {
        throw new ProviderApplicationError("managedByEnvironment");
      }
      if (input.provider !== provider) throw new ProviderApplicationError("invalidInput");
      return serialize<ProviderApplicationSaveResult>(queues, provider, () =>
        provider === "slack" && input.provider === "slack"
          ? beginSlackConfiguration(
              options,
              request,
              account,
              callbackOrigin,
              input,
              providerApplicationReturnRoute(surface),
            )
          : verifyAndActivateProvider(options, account, provider, input, callbackOrigin),
      );
    },

    async beginConnection(request, provider, organizationId, surface) {
      rejectMutation(options, request);
      await requireOperator(options, request);
      const callbackOrigin = await safeCallbackOrigin(options, request);
      const stored = await options.store.read(provider);
      const configuration = options.environment[provider] ?? stored?.configuration;
      if (configuration === undefined || options.beginCandidateConnection === undefined) {
        throw new ProviderApplicationError("invalidInput");
      }
      const configurationVersion =
        options.environment[provider] === undefined ? stored!.version : 0;
      return serialize(queues, provider, async () => {
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
          const result = await options.beginCandidateConnection!(
            request,
            organizationId,
            providerApplicationReturnRoute(surface),
            (candidateRequest) => candidate!.beginConnection!(candidateRequest),
          );
          await candidate.close();
          return result;
        } catch {
          await candidate?.close().catch(() => undefined);
          throw new ProviderApplicationError("unreachable");
        }
      });
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
  } catch {
    throw new ProviderApplicationError("forbidden");
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
  } catch {
    throw new ProviderApplicationError("invalidOrigin");
  }
}

function serialize<T>(
  queues: Map<Provider, Promise<void>>,
  provider: Provider,
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
  identity: ProviderApplicationIdentity | null,
  connections: readonly ConnectedProviderIdentity[],
): ProviderApplicationStatus {
  if (environmentManaged) return "managedByEnvironment";
  if (connections.some((connection) => connection.status === "actionNeeded")) return "actionNeeded";
  if (connections.length > 0) return "connected";
  return identity === null ? "notConfigured" : "verified";
}

function publicIdentifiers(
  configuration: ProviderApplicationConfiguration,
): Readonly<Record<string, string>> {
  switch (configuration.provider) {
    case "github":
      return {
        appId: configuration.appId,
        appSlug: configuration.appSlug,
        clientId: configuration.clientId,
      };
    case "slack":
      return { appId: configuration.appId, clientId: configuration.clientId };
    case "discord":
      return { applicationId: configuration.applicationId };
  }
  throw new Error("unknown provider configuration");
}

function withoutExpectedVersion(
  input: ProviderApplicationConfiguration,
): ProviderApplicationConfiguration {
  const { expectedVersion: _expectedVersion, ...configuration } = input;
  return configuration as ProviderApplicationConfiguration;
}

function sameExternalIdentity(
  left: ProviderApplicationIdentity,
  right: ProviderApplicationIdentity,
): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function isConfigurationConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    Reflect.get(error, "name") === "ProviderConfigurationConflictError"
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

function parseHttpOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid origin");
  if (url.username !== "" || url.password !== "") throw new Error("invalid origin");
  return url.origin;
}

async function beginSlackConfiguration(
  options: ProviderApplicationsOptions,
  request: Request,
  account: AccountAccessValue,
  callbackOrigin: string,
  input: SlackProviderApplicationConfiguration,
  returnRoute: string,
): Promise<ProviderApplicationContinuation> {
  if (!callbackOrigin.startsWith("https://")) {
    throw new ProviderApplicationError("httpsRequired", callbackOrigin);
  }
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
    await candidate.close().catch(() => undefined);
    throw new ProviderApplicationError("unreachable");
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
    await candidate.close().catch(() => undefined);
    if (error instanceof ProviderApplicationError) throw error;
    throw new ProviderApplicationError("unreachable");
  }
}

async function verifyAndActivateProvider(
  options: ProviderApplicationsOptions,
  account: AccountAccessValue,
  provider: Provider,
  input: ProviderApplicationConfiguration,
  callbackOrigin: string,
): Promise<ProviderApplicationResult> {
  let identity: ProviderApplicationIdentity;
  try {
    identity = await options.verifier.verify(provider, input);
  } catch (error) {
    if (error instanceof ProviderVerificationError) {
      throw new ProviderApplicationError(error.reason);
    }
    throw new ProviderApplicationError("unreachable");
  }
  if (identity.provider !== provider) throw new ProviderApplicationError("credentialsRejected");
  const previous = await options.store.read(provider);
  const connections = await options.inventory.connectedIdentities(provider);
  if (
    connections.length > 0 &&
    previous !== undefined &&
    !sameExternalIdentity(previous.identity, identity)
  ) {
    throw new ProviderApplicationError("identityConflict", previous.identity.name);
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
    await candidate.start();
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
    await candidate?.close().catch(() => undefined);
    if (error instanceof ProviderApplicationError) throw error;
    if (isConfigurationConflict(error)) {
      throw new ProviderApplicationError("configurationConflict");
    }
    throw new ProviderApplicationError("unreachable");
  }
}

async function completeSlackInstallation(
  options: ProviderApplicationsOptions,
  input: {
    configuration: unknown;
    expectedConfigurationVersion: number | undefined;
    callbackOrigin: string;
    userId: string;
    installation: VerifiedSlackInstallation;
  },
): Promise<void> {
  const configuration = parseProviderApplicationConfiguration(input.configuration);
  if (configuration.provider !== "slack" || configuration.appId !== input.installation.appId) {
    throw new ProviderApplicationError("credentialsRejected");
  }
  const previous = await options.store.read("slack");
  const connections = await options.inventory.connectedIdentities("slack");
  const identity: ProviderApplicationIdentity = {
    provider: "slack",
    id: input.installation.appId,
    name: input.installation.appId,
  };
  if (
    connections.length > 0 &&
    previous !== undefined &&
    !sameExternalIdentity(previous.identity, identity)
  ) {
    throw new ProviderApplicationError("identityConflict", previous.identity.name);
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
    await options.store.save({
      provider: "slack",
      configuration,
      identity,
      expectedVersion: input.expectedConfigurationVersion,
      updatedByUserId: input.userId,
    });
    candidate.publish();
    candidate = undefined;
  } catch (error) {
    await candidate?.close().catch(() => undefined);
    throw error;
  }
}
