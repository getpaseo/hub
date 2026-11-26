import { createExecutionLauncher } from "./agent-executions/launcher.js";
import { createWebhookProvider, handleWebhookDelivery } from "./triggers/webhook/index.js";
import { createScheduleSource, createScheduleProvider } from "./triggers/schedule/index.js";
import { createExecutionCapabilityServer } from "./execution-capabilities/server.js";
import { OutputExecutorRegistry } from "./execution-capabilities/outputs.js";
import {
  createAttachmentCapabilityRegistry,
  type AttachmentCapabilityRegistry,
  type AttachmentProvider,
  type AttachmentResolver,
} from "./attachments/capabilities.js";
import {
  ProjectConfigurationStore,
  type DaemonAgentConfigurationValidator,
  validateHubBundleForOrganization,
} from "./configuration/store.js";
import type {
  AcceptedTriggerRunRecord,
  Database,
  TriggerRunRecord,
  WorkflowDeadlineRecovery,
} from "./db/types.js";
import { DatabaseUnavailableError } from "./db/errors.js";
import {
  ActiveDaemonRegistry,
  createDaemonUpgradeHandler,
  createDaemonModule,
  enrollDaemon,
  revokeDaemon,
  updateDaemonPermissions,
  type DaemonClock,
  type DaemonConnection,
  type DaemonConnections,
  type DaemonModule,
} from "./daemons/index.js";
import { createDispatcherWithEngine } from "./dispatcher/index.js";
import type {
  DaemonDispatchLifecycleOptions,
  ExecutionDeadlineClock,
} from "./daemons/lifecycle.js";
import type {
  TriggerProviderExecutionControl,
  TriggerProviderFactory,
  TriggerProviderResources,
} from "./providers/registration.js";
import type { TriggerProvider, TriggerSource } from "./triggers/index.js";
import {
  createManualTriggerSource,
  dispatchManualTrigger,
  handleManualTriggerRequest,
} from "./triggers/manual/source.js";
import { createManualRunProvider } from "./triggers/manual/provider.js";
import { OrganizationTriggerStore } from "./triggers/store.js";
import { DaemonRegistration, type OrganizationDaemonScope } from "./daemons/registration.js";
import { CliAuthorizations } from "./cli-authorizations/index.js";
import type { BrowserOrganizationAccess } from "./auth/browser-organization-access.js";
import { createPublicApi, type PublicApi, type PublicApiComposition } from "./public-api/index.js";
import { createPublicOperations } from "./public-operations/index.js";
import { createDatabasePublicOperationRepository } from "./public-operations/database-adapter.js";
import type { EntitlementsService } from "./entitlements/service.js";
import type { ExecutionAuthority } from "./execution-authority/index.js";

export interface HubRuntimeOptions {
  integrationTools?: import("./integration-tools/index.js").IntegrationToolHandlers;
  database: Database | null;
  /** Required end to end so the executions meter can never be silently skipped. */
  entitlements: EntitlementsService | null;
  providers?: readonly TriggerProvider[];
  providerFactories?: readonly TriggerProviderFactory[];
  executionAuthority?: ExecutionAuthority;
  attachmentResolvers?: Partial<Record<AttachmentProvider, AttachmentResolver>>;
  connectionsForProject?: TriggerProviderResources["connectionsForProject"];
  configurationRevisionId?: string;
  outputRegistry?: OutputExecutorRegistry;
  publicApi: PublicApiComposition;
  completionTokenSecret?: string;
  publicBaseUrl?: string;
  daemonClock?: DaemonClock;
  executionDeadlineClock?: ExecutionDeadlineClock;
  dispatchTimeoutMs?: number;
  browserOrganizationAccess?: BrowserOrganizationAccess;
  /** Replaces the process's own daemon registry as the source of live daemon connections. */
  daemonConnections?: DaemonConnections;
}

export interface HubRuntime {
  daemonModule: DaemonModule | null;
  connectionForDaemon(daemonId: string): import("./daemons/index.js").DaemonConnection | undefined;
  /** The daemons' own answer about an agent configuration; null without a database. */
  agentValidator: DaemonAgentConfigurationValidator | null;
  resourceCounts(): {
    executionSubscriptions: number;
  };
  processWorkflowOutbox(): Promise<void>;
  handleUpgrade: ReturnType<typeof createDaemonUpgradeHandler> | null;
  start(sources?: readonly TriggerSource[]): Promise<void>;
  stop(): Promise<void>;
}

export interface HubOperations {
  handleDaemonEnrollment(request: Request): Promise<Response>;
  handleDaemonRevocation(request: Request, daemonId: string): Promise<Response>;
  handleDaemonPermissionUpdate(request: Request, daemonId: string): Promise<Response>;
  handleCliAuthorizationStart(request: Request): Promise<Response>;
  handleCliAuthorizationPoll(request: Request): Promise<Response>;
  handleCliAuthorizationInspect(request: Request): Promise<Response>;
  handleCliAuthorizationDecision(request: Request): Promise<Response>;
  handleOrganizationDaemons(request: Request, organizationSlug: string): Promise<Response>;
  handleOrganizationDaemonRename(
    request: Request,
    input: OrganizationDaemonScope & { slug: string },
  ): Promise<Response>;
  handleOrganizationDaemonRevocation(
    request: Request,
    input: OrganizationDaemonScope,
  ): Promise<Response>;
  handleSessionCapabilities(request: Request, sessionId: string): Promise<Response>;
  handleExecutionCapabilities(request: Request, executionId: string): Promise<Response>;
  handleExecutionLauncher(request: Request, executionId: string): Promise<Response>;
  handleAttachmentDownload(
    request: Request,
    executionId: string,
    attachmentId: string,
  ): Promise<Response>;
  handleWebhookDelivery(request: Request, endpointId: string): Promise<Response>;
  handleManualTrigger(request: Request, entrypoint: "trigger" | "smoke"): Promise<Response>;
}

export interface HubApplication {
  hub: HubRuntime;
  operations: HubOperations;
  publicApi: PublicApi;
  configurationForProject(projectId: string): ProjectConfigurationStore;
}

/** Without a database there is no daemon registry, so no daemon is connected. */
const NO_DAEMON_CONNECTIONS: DaemonConnections = {
  connection: () => undefined,
  dispatchableDaemonIds: () => [],
};

function appDaemonConnections(
  options: HubRuntimeOptions,
  daemons: ActiveDaemonRegistry | null,
): DaemonConnections {
  return options.daemonConnections ?? daemons ?? NO_DAEMON_CONNECTIONS;
}

export function createHubRuntime(options: HubRuntimeOptions): HubRuntime {
  return createHubApplication(options).hub;
}

export function createHubApplication(options: HubRuntimeOptions): HubApplication {
  const daemons =
    options.database === null
      ? null
      : new ActiveDaemonRegistry(options.database, options.daemonClock);
  const daemonConnections = appDaemonConnections(options, daemons);
  const connectionForDaemon = (daemonId: string) => daemonConnections.connection(daemonId);
  const agentValidator = createAgentValidator(daemons, connectionForDaemon);
  const storeForProject = (projectId: string) => {
    if (options.database === null) throw new DatabaseUnavailableError();
    return new ProjectConfigurationStore(options.database, projectId, agentValidator ?? undefined);
  };
  const manualProvider =
    options.database === null ? undefined : createManualRunProvider(storeForProject);
  const attachments = createAttachmentRegistry(options);
  // Providers are created before the daemon module that depends on them, so execution control
  // binds to the module lazily; it is only ever invoked while handling live events.
  let executionDaemonModule: DaemonModule | null | undefined;
  const configuredProviders =
    options.database === null
      ? []
      : (options.providerFactories ?? []).map((factory) =>
          factory({
            configurationStoreForProject: storeForProject,
            connectionsForProject:
              options.connectionsForProject ??
              (() => () => {
                throw new Error("no connection resolver registered");
              }),
            ...(attachments === undefined ? {} : { attachments }),
            executions: executionControlFor(() => executionDaemonModule),
          }),
        );
  const providers = [
    createScheduleProvider(),
    createWebhookProvider(),
    manualProvider,
    ...configuredProviders,
    ...(options.providers ?? []),
  ].filter((provider): provider is TriggerProvider => provider !== undefined);
  const outputRegistry = options.outputRegistry ?? new OutputExecutorRegistry();
  const daemonModule = createAppDaemonModule(
    options,
    connectionForDaemon,
    providers,
    outputRegistry,
  );
  executionDaemonModule = daemonModule;
  const capabilityServer = createAppExecutionCapabilityServer(
    options,
    daemonModule,
    outputRegistry,
  );
  const registration =
    options.database === null || daemons === null
      ? null
      : new DaemonRegistration({
          database: options.database,
          activeDaemons: daemons,
          ...(options.browserOrganizationAccess === undefined
            ? {}
            : { access: options.browserOrganizationAccess }),
        });
  const cliAuthorizations =
    options.database === null
      ? null
      : new CliAuthorizations(
          options.database,
          options.browserOrganizationAccess,
          options.publicBaseUrl,
        );

  const scheduleSource = appScheduleSource(options.database);
  const manualSource =
    options.database === null ? undefined : createManualTriggerSource(options.database);
  const durableDispatchHandler =
    options.database === null || daemonModule === null
      ? undefined
      : (intent: Parameters<DaemonModule["lifecycle"]["handoffLaunchMachineIntent"]>[0]) =>
          daemonModule.lifecycle.handoffLaunchMachineIntent(intent);
  const dispatcherOptions = {
    dispatchableDaemonIds: () => daemonConnections.dispatchableDaemonIds(),
    database: options.database,
    entitlements: options.entitlements,
    providers,
    ...(options.configurationRevisionId === undefined
      ? {}
      : { configurationRevisionId: options.configurationRevisionId }),
    ...(options.executionDeadlineClock === undefined
      ? {}
      : { now: () => new Date(options.executionDeadlineClock!.now()) }),
    ...(options.outputRegistry === undefined
      ? {}
      : {
          validateLaunchMachineIntent: (
            intent: import("./dispatcher/launch-machine-intent.js").LaunchMachineIntent,
          ) =>
            options.outputRegistry!.validateRequiredOutputs(
              intent.allowOutputs,
              intent.outputContext,
            ),
        }),
    ...(daemonModule === null
      ? {}
      : {
          onWorkflowDeadlineExceeded: async (recovery: WorkflowDeadlineRecovery) => {
            await daemonModule.lifecycle.recoverWorkflowDeadlineExecutions(
              recovery.executionIds,
              recovery.completedExecutionIds ?? [],
            );
          },
          onWorkflowRunAccepted: (run: AcceptedTriggerRunRecord) =>
            daemonModule.lifecycle.notifyWorkflowRunAccepted(run),
          onWorkflowRunStarted: (run: AcceptedTriggerRunRecord) =>
            daemonModule.lifecycle.notifyWorkflowRunStarted(run),
          onWorkflowRunTerminal: (run: TriggerRunRecord) =>
            daemonModule.lifecycle.notifyWorkflowRunTerminal(run),
        }),
  };
  const { handler: workflowDispatcher, engine: workflowEngine } = createDispatcherWithEngine({
    ...dispatcherOptions,
    ...(durableDispatchHandler === undefined
      ? {}
      : { dispatchLaunchMachineIntent: durableDispatchHandler }),
  });
  connectDaemonLifecycle(daemons, daemonModule);
  let activeSources: readonly TriggerSource[] = [];

  const hub: HubRuntime = {
    daemonModule,
    connectionForDaemon,
    agentValidator,
    resourceCounts: () => ({
      executionSubscriptions: daemonModule?.lifecycle.activeExecutionObservationCount() ?? 0,
    }),
    processWorkflowOutbox: () => workflowEngine.processAvailable(),
    handleUpgrade:
      options.database === null ? null : createDaemonUpgradeHandler(options.database, daemons!),
    async start(sources = []) {
      await options.executionAuthority?.recover();
      await Promise.all([
        daemonModule?.lifecycle.recoverAgentExecutionDeadlines(),
        daemonModule?.lifecycle.recoverPendingHubActions(),
      ]);
      workflowEngine.start();
      activeSources = [
        ...(manualSource === undefined ? [] : [manualSource]),
        ...(scheduleSource === undefined ? [] : [scheduleSource]),
        ...sources,
      ];
      await Promise.all(activeSources.map(async (source) => source.start(workflowDispatcher)));
    },
    async stop() {
      try {
        await Promise.all(activeSources.map(async (source) => source.stop()));
        activeSources = [];
        await Promise.all([workflowEngine.stop(), daemonModule?.lifecycle.stop(), daemons?.stop()]);
      } finally {
        await options.executionAuthority?.stop();
      }
    },
  };
  const publicOperations = createAppPublicOperations(
    options,
    manualSource,
    storeForProject,
    agentValidator,
  );
  const publicApi = createPublicApi(options.publicApi, publicOperations);
  const operations: HubOperations = {
    handleDaemonEnrollment: (request) =>
      options.database === null
        ? databaseUnavailable()
        : enrollDaemon(request, options.database, options.publicBaseUrl, options.daemonClock),
    handleDaemonRevocation: (request, daemonId) =>
      options.database === null || daemons === null
        ? databaseUnavailable()
        : revokeDaemon(request, daemonId, options.database, daemons),
    handleDaemonPermissionUpdate: (request, daemonId) =>
      options.database === null || daemons === null
        ? databaseUnavailable()
        : updateDaemonPermissions(request, daemonId, options.database, daemons),
    handleCliAuthorizationStart: (request) =>
      cliAuthorizations === null ? databaseUnavailable() : cliAuthorizations.start(request),
    handleCliAuthorizationPoll: (request) =>
      cliAuthorizations === null ? databaseUnavailable() : cliAuthorizations.poll(request),
    handleCliAuthorizationInspect: (request) =>
      cliAuthorizations === null ? databaseUnavailable() : cliAuthorizations.inspect(request),
    handleCliAuthorizationDecision: (request) =>
      cliAuthorizations === null ? databaseUnavailable() : cliAuthorizations.decide(request),
    handleOrganizationDaemons: (request, organizationSlug) =>
      registration === null ? databaseUnavailable() : registration.list(request, organizationSlug),
    handleOrganizationDaemonRename: (request, input) =>
      registration === null ? databaseUnavailable() : registration.rename(request, input),
    handleOrganizationDaemonRevocation: (request, input) =>
      registration === null ? databaseUnavailable() : registration.revoke(request, input),
    handleSessionCapabilities: (request, sessionId) =>
      capabilityServer === null
        ? databaseUnavailable()
        : capabilityServer.handleSession(request, sessionId),
    handleExecutionCapabilities: (request, executionId) =>
      capabilityServer === null
        ? databaseUnavailable()
        : capabilityServer.handle(request, executionId),
    handleExecutionLauncher: createExecutionLauncher(
      options.database,
      options.browserOrganizationAccess,
    ),
    handleAttachmentDownload: (request, executionId, attachmentId) =>
      attachments === undefined
        ? databaseUnavailable()
        : attachments.handle(request, executionId, attachmentId),
    handleWebhookDelivery: (request, endpointId) =>
      options.database === null || options.entitlements === null
        ? databaseUnavailable()
        : handleWebhookDelivery(
            request,
            endpointId,
            options.database.webhooks,
            options.entitlements,
          ),
    handleManualTrigger: (request, entrypoint) =>
      manualSource === undefined
        ? databaseUnavailable()
        : handleManualTriggerRequest(request, manualSource, entrypoint),
  };
  return { hub, operations, publicApi, configurationForProject: storeForProject };
}

/**
 * Every question Hub asks a daemon goes through its connection, so a test that stands in a
 * connection stands in for agent validation too.
 */
function createAgentValidator(
  daemons: ActiveDaemonRegistry | null,
  connectionForDaemon: (daemonId: string) => DaemonConnection | undefined,
): DaemonAgentConfigurationValidator | null {
  if (daemons === null) return null;
  return {
    validateAgentConfiguration: ({ daemonId, cwd }, agent) =>
      connectionForDaemon(daemonId)?.validateAgentConfiguration(agent, { cwd }) ??
      Promise.reject(new Error("daemon_not_connected")),
  };
}

function createAppPublicOperations(
  options: HubRuntimeOptions,
  manualSource: ReturnType<typeof createManualTriggerSource> | undefined,
  configurationForProject: (projectId: string) => ProjectConfigurationStore,
  daemonAgentValidator: DaemonAgentConfigurationValidator | null,
) {
  if (options.database === null || manualSource === undefined || daemonAgentValidator === null) {
    return null;
  }
  const database = options.database;
  return createPublicOperations(
    createDatabasePublicOperationRepository(database),
    {
      triggerForOrganization: (organizationId) => {
        const store = new OrganizationTriggerStore(database, organizationId, daemonAgentValidator);
        return {
          rotateWebhookSecret: (triggerId) => database.webhooks.rotate(organizationId, triggerId),
          async list() {
            return Promise.all(
              (await store.list()).map(async (trigger) => ({
                id: trigger.id,
                name: trigger.name,
                enabled: trigger.enabled,
                format: trigger.format,
                yaml: (await store.activeRevision(trigger)).yaml,
              })),
            );
          },
          async validate(yaml) {
            const prepared = await store.validate(yaml);
            return { name: prepared.compiled.authored.name };
          },
          async install(input) {
            const prepared = await store.validate(input.yaml);
            const existing = (await store.list()).find(
              ({ name }) => name === prepared.compiled.authored.name,
            );
            const { trigger } = await store.save({
              ...(existing === undefined ? {} : { triggerId: existing.id }),
              yaml: input.yaml,
              userId: null,
              sourceEvidence: {
                kind: input.credentialKind === "apiKey" ? "api-key" : "cli-credential",
                credentialId: input.credentialId,
                authoredFormat: "self_contained_trigger_v1",
              },
            });
            const revision = await store.activeRevision(trigger);
            return {
              triggerId: trigger.id,
              name: trigger.name,
              revisionId: revision.id,
              version: revision.version,
            };
          },
        };
      },
      configurationForProject,
      validateBundleForOrganization: (organizationId, files) =>
        validateHubBundleForOrganization(
          database,
          organizationId,
          files,
          daemonAgentValidator ?? undefined,
        ),
      dispatchManualEvent: (input) => dispatchManualTrigger(manualSource, input),
    },
    options.daemonClock,
  );
}

function createAppExecutionCapabilityServer(
  options: HubRuntimeOptions,
  daemonModule: DaemonModule | null,
  outputRegistry: OutputExecutorRegistry,
) {
  if (options.database === null || daemonModule === null) {
    return null;
  }
  return createExecutionCapabilityServer({
    ...(options.completionTokenSecret === undefined
      ? {}
      : { completionTokenSecret: options.completionTokenSecret }),
    database: options.database,
    ...(options.publicBaseUrl === undefined ? {} : { publicBaseUrl: options.publicBaseUrl }),
    outputs: outputRegistry,
    ...(options.integrationTools === undefined
      ? {}
      : { integrationTools: options.integrationTools }),
    completeExecution: (input) =>
      daemonModule.lifecycle.completeAgentExecutionFromCallback(input, { deferHubAction: true }),
  });
}

function createAttachmentRegistry(
  options: HubRuntimeOptions,
): AttachmentCapabilityRegistry | undefined {
  if (
    options.database === null ||
    options.publicBaseUrl === undefined ||
    options.completionTokenSecret === undefined
  ) {
    return undefined;
  }
  return createAttachmentCapabilityRegistry({
    database: options.database,
    publicBaseUrl: options.publicBaseUrl,
    authoritySecret: options.completionTokenSecret,
    resolvers: options.attachmentResolvers ?? {},
  });
}

function databaseUnavailable(): Promise<Response> {
  return Promise.resolve(Response.json({ error: "database_unavailable" }, { status: 503 }));
}

function connectDaemonLifecycle(
  daemons: ActiveDaemonRegistry | null,
  daemonModule: DaemonModule | null,
): void {
  daemons?.onConnected((daemon) => daemonModule?.lifecycle.recoverDaemon(daemon));
  daemons?.onRevoked((daemon) =>
    daemonModule?.lifecycle.failPendingExecutionsForDisconnectedMachine(
      daemon.machineId,
      "daemon_revoked",
    ),
  );
}

function executionControlFor(
  daemonModule: () => DaemonModule | null | undefined,
): TriggerProviderExecutionControl {
  return {
    stopActive: async (input) => {
      const current = daemonModule()?.lifecycle;
      if (current === undefined) {
        throw new Error("execution control is unavailable before the daemon module");
      }
      const stopped = await current.stopAgentExecutions(input);
      return { stopped: stopped.executions.length + stopped.runs.length };
    },
  };
}

function createAppDaemonModule(
  options: HubRuntimeOptions,
  connectionForDaemon: DaemonDispatchLifecycleOptions["connectionForDaemon"],
  providers: readonly TriggerProvider[],
  outputRegistry: OutputExecutorRegistry,
): DaemonModule | null {
  if (options.database === null) {
    return null;
  }

  const usesTestTiming =
    options.executionDeadlineClock !== undefined || options.dispatchTimeoutMs !== undefined;
  return createDaemonModule({
    database: options.database,
    connectionForDaemon,
    executionCapabilities: outputRegistry,
    ...(options.completionTokenSecret === undefined
      ? {}
      : { completionTokenSecret: options.completionTokenSecret }),
    providers,
    ...(options.executionAuthority === undefined
      ? {}
      : { executionAuthority: options.executionAuthority }),
    ...(options.publicBaseUrl === undefined ? {} : { publicBaseUrl: options.publicBaseUrl }),
    ...(usesTestTiming
      ? {
          test: {
            ...(options.executionDeadlineClock === undefined
              ? {}
              : { deadlineClock: options.executionDeadlineClock }),
            ...(options.dispatchTimeoutMs === undefined
              ? {}
              : { dispatchTimeoutMs: options.dispatchTimeoutMs }),
          },
        }
      : {}),
  });
}

function appScheduleSource(database: Database | null): TriggerSource | undefined {
  return database === null ? undefined : createScheduleSource(database.schedules);
}
