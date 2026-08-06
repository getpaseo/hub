import { createExecutionCapabilityServer } from "./execution-capabilities/server.js";
import { OutputExecutorRegistry } from "./execution-capabilities/outputs.js";
import {
  createAttachmentCapabilityRegistry,
  type AttachmentCapabilityRegistry,
  type AttachmentProvider,
  type AttachmentResolver,
} from "./attachments/capabilities.js";
import type { ApiKeyScope } from "./auth/api-key-contract.js";
import { requireOperation, type OperationAuthenticator } from "./auth/operation-auth.js";
import type { OperationAuthorization } from "./auth/api-keys.js";
import { ProjectConfigurationStore } from "./configuration/store.js";
import { installConfiguration } from "./config/admin-routes.js";
import type { Database, TriggerRunRecord, WorkflowDeadlineRecovery } from "./db/types.js";
import { DatabaseUnavailableError } from "./db/errors.js";
import {
  ActiveDaemonRegistry,
  createDaemonUpgradeHandler,
  createDaemonModule,
  enrollDaemon,
  issueEnrollmentToken,
  revokeDaemon,
  type DaemonClock,
  type DaemonModule,
} from "./daemons/index.js";
import { createDispatcherWithEngine } from "./dispatcher/index.js";
import type {
  DaemonDispatchLifecycleOptions,
  ExecutionDeadlineClock,
} from "./daemons/lifecycle.js";
import type {
  ProviderIntegrationRegistration,
  TriggerProviderFactory,
  TriggerProviderResources,
} from "./providers/registration.js";
import type { TriggerProvider, TriggerSource } from "./triggers/index.js";
import { createManualTriggerSource, handleManualTriggerRequest } from "./triggers/manual/source.js";
import { createManualRunProvider } from "./triggers/manual/provider.js";
import { runManualTrigger } from "./triggers/manual/routes.js";
import { DaemonRegistration, type BrowserOrganizationAccess } from "./daemons/registration.js";

export interface HubRuntimeOptions {
  database: Database | null;
  providers?: readonly TriggerProvider[];
  providerFactories?: readonly TriggerProviderFactory[];
  integrations?: readonly ProviderIntegrationRegistration[];
  attachmentResolvers?: Partial<Record<AttachmentProvider, AttachmentResolver>>;
  connectionsForProject?: TriggerProviderResources["connectionsForProject"];
  configurationRevisionId?: string;
  outputRegistry?: OutputExecutorRegistry;
  operationAuth?: OperationAuthenticator;
  completionTokenSecret?: string;
  publicBaseUrl?: string;
  daemonClock?: DaemonClock;
  executionDeadlineClock?: ExecutionDeadlineClock;
  dispatchTimeoutMs?: number;
  browserOrganizationAccess?: BrowserOrganizationAccess;
  daemonConnectionForId?: DaemonDispatchLifecycleOptions["connectionForDaemon"];
}

export interface HubRuntime {
  daemonModule: DaemonModule | null;
  resourceCounts(): {
    recoveredExecutionSubscriptions: number;
  };
  processWorkflowOutbox(): Promise<void>;
  handleUpgrade: ReturnType<typeof createDaemonUpgradeHandler> | null;
  start(sources?: readonly TriggerSource[]): Promise<void>;
  stop(): Promise<void>;
}

export interface HubOperations {
  handleEnrollmentToken(request: Request): Promise<Response>;
  handleDaemonEnrollment(request: Request): Promise<Response>;
  handleDaemonRevocation(request: Request, daemonId: string): Promise<Response>;
  handleDeviceAuthorizationStart(request: Request): Promise<Response>;
  handleDeviceAuthorizationPoll(request: Request): Promise<Response>;
  handleDeviceAuthorizationInspect(request: Request): Promise<Response>;
  handleDeviceAuthorizationDecision(request: Request): Promise<Response>;
  handleOrganizationDaemons(request: Request): Promise<Response>;
  handleOrganizationDaemonRename(request: Request, daemonId: string): Promise<Response>;
  handleOrganizationDaemonRevocation(request: Request, daemonId: string): Promise<Response>;
  handleExecutionCapabilities(request: Request, executionId: string): Promise<Response>;
  handleAttachmentDownload(
    request: Request,
    executionId: string,
    attachmentId: string,
  ): Promise<Response>;
  handleConfigurationInstall(request: Request): Promise<Response>;
  handleManualRun(request: Request): Promise<Response>;
  handleManualTrigger(request: Request, entrypoint: "trigger" | "smoke"): Promise<Response>;
}

export interface HubApplication {
  hub: HubRuntime;
  operations: HubOperations;
}

export function createHubRuntime(options: HubRuntimeOptions): HubRuntime {
  return createHubApplication(options).hub;
}

export function createHubApplication(options: HubRuntimeOptions): HubApplication {
  const daemons =
    options.database === null
      ? null
      : new ActiveDaemonRegistry(options.database, options.daemonClock);
  const storeForProject = (projectId: string) => {
    if (options.database === null) throw new DatabaseUnavailableError();
    return new ProjectConfigurationStore(options.database, projectId);
  };
  const manualProvider =
    options.database === null ? undefined : createManualRunProvider(storeForProject);
  const attachments = createAttachmentRegistry(options);
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
          }),
        );
  const providers = [manualProvider, ...configuredProviders, ...(options.providers ?? [])].filter(
    (provider): provider is TriggerProvider => provider !== undefined,
  );
  const daemonModule = createAppDaemonModule(options, daemons, providers);
  const capabilityServer = createAppExecutionCapabilityServer(options, daemonModule);
  const registration =
    options.database === null || daemons === null
      ? null
      : new DaemonRegistration({
          database: options.database,
          activeDaemons: daemons,
          ...(options.browserOrganizationAccess === undefined
            ? {}
            : { access: options.browserOrganizationAccess }),
          ...(options.publicBaseUrl === undefined ? {} : { publicBaseUrl: options.publicBaseUrl }),
        });

  const manualSource =
    options.database === null ? undefined : createManualTriggerSource(options.database);
  const durableDispatchHandler =
    options.database === null || daemonModule === null
      ? undefined
      : (intent: Parameters<DaemonModule["lifecycle"]["handoffLaunchMachineIntent"]>[0]) =>
          daemonModule.lifecycle.handoffLaunchMachineIntent(intent);
  const dispatcherOptions = {
    database: options.database,
    providers,
    ...(options.configurationRevisionId === undefined
      ? {}
      : { configurationRevisionId: options.configurationRevisionId }),
    ...(options.executionDeadlineClock === undefined
      ? {}
      : { now: () => new Date(options.executionDeadlineClock!.now()) }),
    ...(daemonModule === null
      ? {}
      : {
          onWorkflowDeadlineExceeded: async (recovery: WorkflowDeadlineRecovery) => {
            await daemonModule.lifecycle.recoverWorkflowDeadlineExecutions(recovery.executionIds);
          },
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
    resourceCounts: () => ({
      recoveredExecutionSubscriptions:
        daemonModule?.lifecycle.activeRecoveryObservationCount() ?? 0,
    }),
    processWorkflowOutbox: () => workflowEngine.processAvailable(),
    handleUpgrade:
      options.database === null ? null : createDaemonUpgradeHandler(options.database, daemons!),
    async start(sources = []) {
      await Promise.all([
        daemonModule?.lifecycle.recoverAgentExecutionDeadlines(),
        daemonModule?.lifecycle.recoverPendingHubActions(),
      ]);
      workflowEngine.start();
      activeSources = [...(manualSource === undefined ? [] : [manualSource]), ...sources];
      await Promise.all(activeSources.map(async (source) => source.start(workflowDispatcher)));
    },
    async stop() {
      await Promise.all(activeSources.map(async (source) => source.stop()));
      activeSources = [];
      await Promise.all([workflowEngine.stop(), daemonModule?.lifecycle.stop(), daemons?.stop()]);
    },
  };
  const operations: HubOperations = {
    handleEnrollmentToken: (request) =>
      machineOperation(request, "daemons:enroll", (authorization) =>
        options.database === null
          ? databaseUnavailable()
          : issueEnrollmentToken(
              request,
              options.database,
              authorization.organizationId,
              authorization.keyId,
              options.daemonClock ?? { nowDate: () => new Date() },
            ),
      ),
    handleDaemonEnrollment: (request) =>
      options.database === null
        ? databaseUnavailable()
        : enrollDaemon(request, options.database, options.publicBaseUrl, options.daemonClock),
    handleDaemonRevocation: (request, daemonId) =>
      options.database === null || daemons === null
        ? databaseUnavailable()
        : revokeDaemon(request, daemonId, options.database, daemons),
    handleDeviceAuthorizationStart: (request) =>
      registration === null ? databaseUnavailable() : registration.start(request),
    handleDeviceAuthorizationPoll: (request) =>
      registration === null ? databaseUnavailable() : registration.poll(request),
    handleDeviceAuthorizationInspect: (request) =>
      registration === null ? databaseUnavailable() : registration.inspect(request),
    handleDeviceAuthorizationDecision: (request) =>
      registration === null ? databaseUnavailable() : registration.decide(request),
    handleOrganizationDaemons: (request) =>
      registration === null ? databaseUnavailable() : registration.list(request),
    handleOrganizationDaemonRename: (request, daemonId) =>
      registration === null ? databaseUnavailable() : registration.rename(request, daemonId),
    handleOrganizationDaemonRevocation: (request, daemonId) =>
      registration === null ? databaseUnavailable() : registration.revoke(request, daemonId),
    handleExecutionCapabilities: (request, executionId) =>
      capabilityServer === null
        ? databaseUnavailable()
        : capabilityServer.handle(request, executionId),
    handleAttachmentDownload: (request, executionId, attachmentId) =>
      attachments === undefined
        ? databaseUnavailable()
        : attachments.handle(request, executionId, attachmentId),
    handleConfigurationInstall: (request) =>
      machineOperation(request, "configuration:install", (authorization) =>
        options.database === null
          ? databaseUnavailable()
          : installConfiguration(request, options.database, storeForProject, authorization),
      ),
    handleManualRun: (request) =>
      machineOperation(request, "runs:dispatch", (authorization) =>
        options.database === null || manualSource === undefined
          ? databaseUnavailable()
          : runManualTrigger(request, manualSource, options.database, authorization),
      ),
    handleManualTrigger: (request, entrypoint) =>
      manualSource === undefined
        ? databaseUnavailable()
        : handleManualTriggerRequest(request, manualSource, entrypoint),
  };
  return { hub, operations };

  async function machineOperation(
    request: Request,
    scope: ApiKeyScope,
    run: (authorization: OperationAuthorization) => Promise<Response>,
  ): Promise<Response> {
    if (options.database === null) return databaseUnavailable();
    if (options.operationAuth === undefined) {
      return Response.json({ error: "auth_unavailable" }, { status: 503 });
    }
    const authorization = await requireOperation(options.operationAuth, request, scope);
    if (authorization instanceof Response) return authorization;
    return run(authorization);
  }
}

function createAppExecutionCapabilityServer(
  options: HubRuntimeOptions,
  daemonModule: DaemonModule | null,
) {
  if (options.database === null || daemonModule === null) {
    return null;
  }
  return createExecutionCapabilityServer({
    database: options.database,
    outputs: options.outputRegistry ?? new OutputExecutorRegistry(),
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

function createAppDaemonModule(
  options: HubRuntimeOptions,
  daemons: ActiveDaemonRegistry | null,
  providers: readonly TriggerProvider[],
): DaemonModule | null {
  if (options.database === null) {
    return null;
  }

  const usesTestTiming =
    options.executionDeadlineClock !== undefined || options.dispatchTimeoutMs !== undefined;
  return createDaemonModule({
    database: options.database,
    connectionForDaemon: options.daemonConnectionForId ?? ((id) => daemons?.connection(id)),
    ...(options.completionTokenSecret === undefined
      ? {}
      : { completionTokenSecret: options.completionTokenSecret }),
    providers,
    integrations: options.integrations ?? [],
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
