import type { z } from "zod";
import type { AuthServer } from "../auth/server.js";
import type { JsonValue } from "../config/compiler.js";
import type {
  ConnectionStartAuthority,
  Database,
  IntegrationConnectionRecord,
  IntegrationConnectionStatus,
  PublicIntegrationConnectionView,
  ReadConnectionAttemptInput,
} from "../db/types.js";
import type { OutputToolDefinition } from "../execution-capabilities/outputs.js";
import type { IntegrationToolCall } from "../integration-tools/http.js";
import type {
  ProviderOutputRegistration,
  ProviderRequestRegistration,
  TriggerProviderFactory,
} from "../providers/registration.js";
import type { TriggerHandler, TriggerSource } from "../triggers/index.js";
import type { IntegrationToolGrantBase, IntegrationTriggerEventSpec } from "./browser-contracts.js";

export type {
  IntegrationConnectionRecord,
  IntegrationConnectionStatus,
  PublicIntegrationConnectionView,
} from "../db/types.js";
export type { IntegrationToolGrantBase, IntegrationTriggerEventSpec } from "./browser-contracts.js";

/**
 * Strips credentials at the boundary before projecting a connection record to
 * browser, dashboard, or API surfaces.
 */
export function toPublicConnectionView(
  record: IntegrationConnectionRecord,
): PublicIntegrationConnectionView {
  const { credentials: _credentials, ...publicView } = record;
  return publicView;
}

/**
 * Normalized actor metadata exposed on inbound integration trigger events so Hub can apply
 * uniform echo suppression across providers without provider-specific branches.
 */
export interface EventActor {
  readonly id: string;
  readonly login?: string;
  readonly isBot: boolean;
  readonly isSelfApp: boolean;
}

/** Optional provenance attached to trigger matches or outbound effects for echo suppression. */
export interface EventProvenanceInput {
  readonly provider: string;
  readonly externalObjectId?: string;
  readonly body?: string;
}

/**
 * Durable inbound event envelope passed through `IntegrationInboundSink.enqueue`.
 *
 * Keeping transport delivery decoupled behind `ingest` allows new integrations to plug
 * directly into durable inbound queues and future `workflows.ingest()` pipelines with no
 * integration code changes.
 */
export interface IntegrationInboundEvent {
  readonly provider: string;
  readonly kind: string;
  readonly deliveryId: string;
  readonly receivedAt: Date;
  readonly payload: JsonValue;
  readonly connectionId?: string | null;
  readonly actor?: EventActor;
}

export type IntegrationEnqueueResult =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate" }
  | { readonly status: "rejected"; readonly reason: string };

export type IntegrationInboundProcessor = (
  event: IntegrationInboundEvent,
  dispatch: TriggerHandler,
) => Promise<void>;

export interface IntegrationInboundSink {
  enqueue(event: IntegrationInboundEvent): Promise<IntegrationEnqueueResult>;
}

export interface IntegrationAppIdentity {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly ownerLogin?: string;
}

export interface BindIntegrationConnectionPayload {
  readonly externalId: string;
  readonly displayName: string;
  readonly providerApplicationId: string;
  readonly status?: IntegrationConnectionStatus;
  readonly scopes?: readonly string[];
  readonly credentials: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly workspaceId?: string | null;
}

export interface IntegrationVerificationContext {
  readonly fetch: typeof fetch;
  readonly callbackOrigin: string;
  readonly now: () => Date;
}

export interface IntegrationSetupActionContext<TAppConfig = unknown> {
  readonly request: Request;
  readonly organizationId: string | null;
  readonly accountId: string;
  readonly callbackOrigin: string;
  readonly configuration: TAppConfig | undefined;
  readonly database: Database;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly payload: unknown;
}

export interface IntegrationOAuthCompletionInput {
  readonly provider: string;
  readonly configuration: unknown;
  readonly identity: IntegrationAppIdentity;
  readonly expectedConfigurationVersion: number | undefined;
  readonly callbackOrigin: string;
  readonly userId: string;
  readonly attempt: ReadConnectionAttemptInput;
  readonly connection: BindIntegrationConnectionPayload;
}

export interface IntegrationRuntimeContext {
  readonly database: Database;
  readonly auth: AuthServer;
  readonly callbackOrigin: string;
  readonly identity: IntegrationAppIdentity;
  readonly configurationVersion: number;
  readonly activation?: {
    readonly expectedConfigurationVersion: number | undefined;
    readonly activateConfiguration: boolean;
  };
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly ingest: IntegrationInboundSink;
  readonly onOAuthInstallation?: (input: IntegrationOAuthCompletionInput) => Promise<void>;
}

export type IntegrationConnectionActionName = "start" | "disconnect" | "callback";

export interface IntegrationConnectionRuntime {
  readonly actions?: Partial<
    Readonly<Record<IntegrationConnectionActionName, (request: Request) => Promise<Response>>>
  >;
  beginConnection?(
    request: Request,
    access?: ConnectionStartAuthority,
  ): Promise<{ readonly url: string }>;
  close?(): Promise<void>;
}

export interface IntegrationConnectionStatusView {
  readonly status:
    | "notConfigured"
    | "disconnected"
    | "connected"
    | "suspended"
    | "requiresReauthorization";
}

export interface ProjectedIntegrationConnection {
  readonly id: string;
  readonly provider: string;
  readonly slug: string;
  readonly externalId: string;
  readonly displayName: string;
  readonly status: "connected" | "suspended" | "requiresReauthorization";
  readonly scopes: readonly string[];
  readonly workspaceId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface IntegrationConnectionCapability<
  TAppConfig = unknown,
  TIdentity extends IntegrationAppIdentity = IntegrationAppIdentity,
> {
  readonly configSchema: z.ZodType<TAppConfig>;
  readonly identitySchema: z.ZodType<TIdentity>;
  readEnvironment(env: NodeJS.ProcessEnv): TAppConfig | undefined;
  sensitiveValues(config: TAppConfig): readonly string[];
  publicIdentifiers(config: TAppConfig): Readonly<Record<string, string>>;
  acceptsEvents(config: TAppConfig): boolean;
  readonly requiresHttps?: boolean;
  /**
   * Direct verification for token/credential-based app setups.
   *
   * Omit or return `undefined` for OAuth-verified setups that redirect to the provider
   * before activating credentials. Returning `initialConnection` atomically binds the
   * connection in the active organization alongside saving app credentials.
   */
  verifyDirect?(
    config: TAppConfig,
    context: IntegrationVerificationContext,
  ): Promise<
    | {
        readonly identity: TIdentity;
        readonly initialConnection?: BindIntegrationConnectionPayload;
      }
    | undefined
  >;
  oauthAppIdentity?(config: TAppConfig): TIdentity;
  readonly setupActions?: Readonly<
    Record<string, (context: IntegrationSetupActionContext<TAppConfig>) => Promise<JsonValue>>
  >;
  connectionStatus(
    records: readonly IntegrationConnectionRecord[],
    now: Date,
  ): IntegrationConnectionStatusView;
  projectConnection(record: IntegrationConnectionRecord, now: Date): ProjectedIntegrationConnection;
  createRuntime(
    config: TAppConfig,
    context: IntegrationRuntimeContext,
  ): IntegrationConnectionRuntime;
}

export interface IntegrationTriggersRuntime {
  readonly sources?: readonly TriggerSource[];
  readonly requests?: readonly ProviderRequestRegistration[];
  readonly ingest?: Readonly<Record<string, IntegrationInboundProcessor>>;
  readonly triggerProvider: TriggerProviderFactory;
  readonly outputs?: readonly ProviderOutputRegistration[];
}

export interface IntegrationTriggersCapability<
  TAppConfig = unknown,
  TTriggerFilters extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly events: readonly IntegrationTriggerEventSpec[];
  readonly filterSchema: z.ZodType<TTriggerFilters> & { readonly shape: z.ZodRawShape };
  validateEventFilters?(event: string, filters: TTriggerFilters, ctx: z.RefinementCtx): void;
  resolveResource?(input: {
    readonly organizationId: string;
    readonly connection: IntegrationConnectionRecord;
    readonly event: string;
    readonly filters: TTriggerFilters;
    readonly database: Database;
  }): Promise<string | null>;
  createRuntime(config: TAppConfig, context: IntegrationRuntimeContext): IntegrationTriggersRuntime;
}

export interface IntegrationToolSpec {
  readonly action: string;
  readonly schema: z.ZodObject;
  readonly definition: OutputToolDefinition;
}

export interface IntegrationToolsCapability<
  TAppConfig = unknown,
  TToolGrant extends IntegrationToolGrantBase = IntegrationToolGrantBase,
> {
  readonly grantSchema: z.ZodType<TToolGrant>;
  normalizeGrant(grant: TToolGrant): TToolGrant;
  readonly tools: readonly IntegrationToolSpec[];
  readonly outboundLinkActions: readonly string[];
  linkFormatHint(url: string): string;
  createHandler(
    config: TAppConfig,
    context: IntegrationRuntimeContext,
  ): (call: IntegrationToolCall<TToolGrant>) => Promise<unknown>;
}

/**
 * Short-lived execution credential capability (e.g. revoking tokens minted for a run).
 *
 * Named `auth` to align with Hub's 4-slot integration capability vocabulary:
 * `connection`, `triggers`, `tools`, `auth` (with optional `steps` reserved for future
 * typed workflow step actions).
 */
export interface IntegrationAuthCapability {
  revoke(token: string): Promise<void>;
}

/**
 * Typed authoring definition passed to `defineIntegration(...)`.
 *
 * `defineIntegration` wraps every capability with boundary schema parsing so
 * `IntegrationRegistry` stores heterogeneous integrations with zero `any`.
 */
export interface TypedIntegrationDefinition<
  TAppConfig,
  TIdentity extends IntegrationAppIdentity = IntegrationAppIdentity,
  TTriggerFilters extends Record<string, unknown> = Record<string, unknown>,
  TToolGrant extends IntegrationToolGrantBase = IntegrationToolGrantBase,
> {
  readonly id: string;
  readonly label: string;
  readonly resourceNoun: string;
  readonly connection: IntegrationConnectionCapability<TAppConfig, TIdentity>;
  readonly triggers?: IntegrationTriggersCapability<TAppConfig, TTriggerFilters>;
  readonly tools?: IntegrationToolsCapability<TAppConfig, TToolGrant>;
  readonly auth?: IntegrationAuthCapability;
}

/**
 * Boundary-validated integration definition held by `IntegrationRegistry`.
 *
 * Capabilities:
 * - `connection`: required app/OAuth/direct-token lifecycle and connection projection
 * - `triggers`: optional inbound events, filters, routing, dispatch, and outputs
 * - `tools`: optional scoped MCP tools granted via `run.tools.<provider>`
 * - `auth`: optional short-lived execution token revocation
 * (An optional `steps` slot is reserved for future typed workflow step executors.)
 */
export interface IntegrationDefinition {
  readonly id: string;
  readonly label: string;
  readonly resourceNoun: string;
  readonly connection: IntegrationConnectionCapability;
  readonly triggers?: IntegrationTriggersCapability;
  readonly tools?: IntegrationToolsCapability;
  readonly auth?: IntegrationAuthCapability;
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
 * Converts a strongly typed integration definition into a boundary-validated
 * `IntegrationDefinition` without unsafe casts or `any`.
 */
export function defineIntegration<
  TAppConfig,
  TIdentity extends IntegrationAppIdentity = IntegrationAppIdentity,
  TTriggerFilters extends Record<string, unknown> = Record<string, unknown>,
  TToolGrant extends IntegrationToolGrantBase = IntegrationToolGrantBase,
>(
  definition: TypedIntegrationDefinition<TAppConfig, TIdentity, TTriggerFilters, TToolGrant>,
): IntegrationDefinition {
  const { connection, triggers, tools, auth } = definition;
  const parseConfig = (value: unknown): TAppConfig => connection.configSchema.parse(value);

  const wrappedSetupActions =
    connection.setupActions === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(connection.setupActions).map(([action, handler]) => [
            action,
            (context: IntegrationSetupActionContext) =>
              handler({
                ...context,
                configuration:
                  context.configuration === undefined
                    ? undefined
                    : parseConfig(context.configuration),
              }),
          ]),
        );

  const wrappedConnection: IntegrationConnectionCapability = {
    configSchema: connection.configSchema,
    identitySchema: connection.identitySchema,
    readEnvironment: (env) => connection.readEnvironment(env),
    sensitiveValues: (config) => connection.sensitiveValues(parseConfig(config)),
    publicIdentifiers: (config) => connection.publicIdentifiers(parseConfig(config)),
    acceptsEvents: (config) => connection.acceptsEvents(parseConfig(config)),
    ...(connection.requiresHttps === undefined ? {} : { requiresHttps: connection.requiresHttps }),
    ...(connection.verifyDirect === undefined
      ? {}
      : {
          verifyDirect: (config, context) => connection.verifyDirect!(parseConfig(config), context),
        }),
    ...(connection.oauthAppIdentity === undefined
      ? {}
      : { oauthAppIdentity: (config) => connection.oauthAppIdentity!(parseConfig(config)) }),
    ...(wrappedSetupActions === undefined ? {} : { setupActions: wrappedSetupActions }),
    connectionStatus: (records, now) => connection.connectionStatus(records, now),
    projectConnection: (record, now) => connection.projectConnection(record, now),
    createRuntime: (config, context) => connection.createRuntime(parseConfig(config), context),
  };

  const wrappedTriggers: IntegrationTriggersCapability | undefined =
    triggers === undefined
      ? undefined
      : {
          events: triggers.events,
          filterSchema: triggers.filterSchema,
          ...(triggers.validateEventFilters === undefined
            ? {}
            : {
                validateEventFilters: (event, filters, ctx) => {
                  const parsed = triggers.filterSchema.safeParse(filters);
                  if (!parsed.success) return;
                  triggers.validateEventFilters!(event, parsed.data, ctx);
                },
              }),
          ...(triggers.resolveResource === undefined
            ? {}
            : {
                resolveResource: (input) => {
                  const parsed = triggers.filterSchema.parse(input.filters);
                  return triggers.resolveResource!({ ...input, filters: parsed });
                },
              }),
          createRuntime: (config, context) => triggers.createRuntime(parseConfig(config), context),
        };

  const wrappedTools: IntegrationToolsCapability | undefined =
    tools === undefined
      ? undefined
      : {
          grantSchema: tools.grantSchema,
          normalizeGrant: (grant) => tools.normalizeGrant(tools.grantSchema.parse(grant)),
          tools: tools.tools,
          outboundLinkActions: tools.outboundLinkActions,
          linkFormatHint: (url) => tools.linkFormatHint(url),
          createHandler: (config, context) => {
            const handler = tools.createHandler(parseConfig(config), context);
            return (call) =>
              handler({
                ...call,
                grant: tools.grantSchema.parse(call.grant),
              });
          },
        };

  return {
    id: definition.id,
    label: definition.label,
    resourceNoun: definition.resourceNoun,
    connection: wrappedConnection,
    ...(wrappedTriggers === undefined ? {} : { triggers: wrappedTriggers }),
    ...(wrappedTools === undefined ? {} : { tools: wrappedTools }),
    ...(auth === undefined ? {} : { auth }),
  };
}
