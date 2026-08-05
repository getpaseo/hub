import type { AllowedOutput } from "../execution-capabilities/outputs.js";
import type { DaemonEnvironmentTarget } from "../dispatcher/launch-machine-intent.js";
import type { DurableTrigger } from "../db/types.js";
import type { WorktreeTarget } from "../config/index.js";

export interface ExternalTrigger {
  triggerId?: string;
  organizationId: string;
  projectId: string;
  source: string;
  deliveryId: string;
  receivedAt: Date;
  payload: unknown;
  connectionId?: string | null;
  resourceId?: string | null;
}

export interface TriggerDispatchOutcome {
  triggerId: string;
}

export type TriggerHandler = (trigger: DurableTrigger) => Promise<TriggerDispatchOutcome | void>;

export interface TriggerSource {
  dispatchMode?: "synchronous" | "durable-handoff";
  start(handler: TriggerHandler): Promise<void>;
  stop(): Promise<void>;
}

export type TriggerEventName = `${string}.${string}`;

export interface TriggerAgentConfig {
  provider: string;
  mode: string;
  model?: string | undefined;
  thinkingOptionId?: string | undefined;
}

export function cleanTriggerAgent(agent: TriggerAgentConfig): TriggerAgentConfig {
  return {
    provider: agent.provider,
    mode: agent.mode,
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.thinkingOptionId === undefined ? {} : { thinkingOptionId: agent.thinkingOptionId }),
  };
}

export interface TriggerProviderMatch<TriggerContext = unknown, OutputContext = TriggerContext> {
  triggerName: string;
  environmentName: string;
  environment: DaemonEnvironmentTarget;
  prompt: string;
  agent: TriggerAgentConfig;
  allowOutputs: readonly AllowedOutput[];
  timeoutMs?: number;
  idleTimeoutMs?: number;
  autoArchive: boolean;
  triggerContext: TriggerContext;
  outputContext: OutputContext;
  configurationRevisionId?: string;
  hubConfig: unknown;
}

export interface TriggerProviderLifecycleResult {
  status: "succeeded" | "failed";
  summary?: string;
}

export interface TriggerLaunchMaterialization<TriggerContext = unknown> {
  executionId: string;
  organizationId: string;
  projectId: string;
  prompt: string;
  environmentEnv?: Record<string, string>;
  environmentWorktree?: WorktreeTarget;
  triggerContext: TriggerContext;
}

export interface MaterializedTriggerLaunch {
  prompt: string;
  environmentEnv?: Record<string, string>;
  environmentWorktree?: WorktreeTarget;
}

export interface TriggerProvider<
  Name extends string = string,
  TriggerContext = unknown,
  OutputContext = TriggerContext,
> {
  name: Name;
  eventNames: readonly TriggerEventName[];
  match(
    trigger: ExternalTrigger,
  ): Promise<readonly TriggerProviderMatch<TriggerContext, OutputContext>[]>;
  materializeLaunch?(
    launch: TriggerLaunchMaterialization<TriggerContext>,
  ): Promise<MaterializedTriggerLaunch>;
  onDispatchAccepted?(triggerContext: TriggerContext, outputContext: OutputContext): Promise<void>;
  onAgentExecutionStarted?(
    triggerContext: TriggerContext,
    outputContext: OutputContext,
  ): Promise<void>;
  onAgentExecutionCompleted?(
    triggerContext: TriggerContext,
    outputContext: OutputContext,
    result: TriggerProviderLifecycleResult,
  ): Promise<void>;
  onAgentExecutionFailed?(
    triggerContext: TriggerContext,
    outputContext: OutputContext,
    reason: string,
  ): Promise<void>;
  onAgentExecutionTerminal?(executionId: string, triggerContext: TriggerContext): Promise<void>;
  onMachineTerminated?(triggerContext: TriggerContext, reason: string): Promise<void>;
}
