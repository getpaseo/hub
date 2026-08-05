import type { AllowedOutput } from "../execution-capabilities/outputs.js";
import type { DaemonEnvironmentTarget } from "../dispatcher/launch-machine-intent.js";
import type { DurableTrigger } from "../db/types.js";
import type { WorktreeTarget } from "../config/index.js";
import type { InvocationParseResult } from "./invocation.js";

export interface ExternalTrigger {
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

export function cleanTriggerAgent(
  agent: Omit<TriggerAgentConfig, "mode"> & { mode?: string | undefined },
): TriggerAgentConfig {
  return {
    provider: agent.provider,
    mode: agent.mode ?? "default",
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.thinkingOptionId === undefined ? {} : { thinkingOptionId: agent.thinkingOptionId }),
  };
}

export interface TriggerProviderMatch<TriggerContext = unknown, OutputContext = TriggerContext> {
  triggerName: string;
  stepId: string;
  environmentName: string;
  environment: DaemonEnvironmentTarget;
  prompt: string;
  agent: TriggerAgentConfig;
  allowOutputs: readonly AllowedOutput[];
  timeoutMs?: number;
  runTimeoutMs?: number;
  idleTimeoutMs?: number;
  autoArchive: boolean;
  triggerContext: TriggerContext;
  outputContext: OutputContext;
  configurationRevisionId?: string;
  hubConfig: unknown;
  invocation: InvocationParseResult;
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
