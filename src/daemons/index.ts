import type { Database } from "../db/types.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { TriggerProvider } from "../triggers/index.js";
import type { ProviderIntegrationRegistration } from "../providers/registration.js";
import {
  createDaemonDispatchLifecycle,
  AgentExecutionCompletionFailure,
  DaemonDispatchFailure,
  DaemonSpawnAckTimeoutError,
  type DaemonDispatchLifecycle,
  type DaemonDispatchResult,
} from "./lifecycle.js";
import type {
  DaemonAgentStreamEvent,
  DaemonConnection,
  DaemonCreateAgentOptions,
} from "./protocol.js";
import type { Logger } from "pino";

export type {
  DaemonAgentStreamEvent,
  DaemonConnection,
  DaemonCreateAgentOptions,
} from "./protocol.js";
export { DaemonDispatchFailure, DaemonSpawnAckTimeoutError };
export { AgentExecutionCompletionFailure };
export { ActiveDaemonRegistry, createDaemonUpgradeHandler, type DaemonClock } from "./registry.js";
export { enrollDaemon, issueEnrollmentToken, revokeDaemon } from "./registration.js";

interface DaemonModuleTestOptions {
  logger?: Logger;
  dispatchTimeoutMs?: number;
  deadlineClock?: import("./lifecycle.js").ExecutionDeadlineClock;
}

export interface DaemonModuleOptions {
  database: Database;
  providers?: readonly TriggerProvider[];
  integrations?: readonly ProviderIntegrationRegistration[];
  connectionForDaemon(daemonId: string): DaemonConnection | undefined;
  publicBaseUrl?: string;
  completionTokenSecret?: string;
  test?: DaemonModuleTestOptions;
}

export interface DaemonModule {
  readonly kind: "daemon-module";
  readonly lifecycle: DaemonDispatchLifecycle;
}

export function createDaemonModule(options: DaemonModuleOptions): DaemonModule {
  return {
    kind: "daemon-module",
    lifecycle: createDaemonDispatchLifecycle({
      database: options.database,
      connectionForDaemon: (daemonId) => options.connectionForDaemon(daemonId),
      providers: options.providers ?? [],
      integrations: options.integrations ?? [],
      ...(options.publicBaseUrl === undefined ? {} : { publicBaseUrl: options.publicBaseUrl }),
      ...(options.completionTokenSecret === undefined
        ? {}
        : { completionTokenSecret: options.completionTokenSecret }),
      ...(options.test === undefined ? {} : { test: options.test }),
    }),
  };
}

export async function dispatchLaunchMachineIntent(
  module: DaemonModule,
  intent: LaunchMachineIntent,
): Promise<DaemonDispatchResult> {
  return await module.lifecycle.dispatchLaunchMachineIntent(intent);
}
