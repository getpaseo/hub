import type { DurableProviderEvent } from "../db/types.js";
import type { WorktreeTarget } from "../config/index.js";
import type { JsonValue } from "../config/compiler.js";
import type { InvocationParseResult } from "./invocation.js";
import type { ProviderEventDropReasonCode } from "./drop-reason.js";

export interface ExternalTrigger {
  providerEventReceiptId: string;
  organizationId: string;
  projectId: string;
  configurationRevisionId: string;
  source: string;
  deliveryId: string;
  receivedAt: Date;
  payload: unknown;
  connectionId?: string | null;
  resourceId?: string | null;
}

export interface TriggerDispatchOutcome {
  providerEventReceiptId: string;
}

export type TriggerHandler = (
  trigger: DurableProviderEvent,
) => Promise<TriggerDispatchOutcome | void>;

export interface TriggerSource {
  start(handler: TriggerHandler): Promise<void>;
  stop(): Promise<void>;
}

export type TriggerEventName = `${string}.${string}`;

export interface TriggerAgentConfig {
  provider: string;
  mode?: string | undefined;
  model?: string | undefined;
  thinkingOptionId?: string | undefined;
  options?: Readonly<Record<string, JsonValue>> | undefined;
}

export function cleanTriggerAgent(agent: TriggerAgentConfig): TriggerAgentConfig {
  return {
    provider: agent.provider,
    ...(agent.mode === undefined ? {} : { mode: agent.mode }),
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.thinkingOptionId === undefined ? {} : { thinkingOptionId: agent.thinkingOptionId }),
    ...(agent.options === undefined ? {} : { options: structuredClone(agent.options) }),
  };
}

interface TriggerProviderMatchBase<TriggerContext, OutputContext> {
  triggerName: string;
  triggerContext: TriggerContext;
  outputContext: OutputContext;
  configurationRevisionId?: string;
  hubConfig: unknown;
}

export interface AcceptedTriggerProviderMatch<
  TriggerContext = unknown,
  OutputContext = TriggerContext,
> extends TriggerProviderMatchBase<TriggerContext, OutputContext> {
  invocation: Extract<InvocationParseResult, { status: "accepted" }>;
}

export interface RejectedTriggerProviderMatch<
  TriggerContext = unknown,
  OutputContext = TriggerContext,
> extends TriggerProviderMatchBase<TriggerContext, OutputContext> {
  invocation: Extract<InvocationParseResult, { status: "rejected" }>;
}

export type TriggerProviderMatch<TriggerContext = unknown, OutputContext = TriggerContext> =
  | AcceptedTriggerProviderMatch<TriggerContext, OutputContext>
  | RejectedTriggerProviderMatch<TriggerContext, OutputContext>;

export type TriggerProviderResult<TriggerContext = unknown, OutputContext = TriggerContext> =
  | readonly TriggerProviderMatch<TriggerContext, OutputContext>[]
  | ProviderEventDropReasonCode;

export function isAcceptedTriggerProviderMatch<TriggerContext, OutputContext>(
  match: TriggerProviderMatch<TriggerContext, OutputContext> | string | undefined,
): match is AcceptedTriggerProviderMatch<TriggerContext, OutputContext> {
  return typeof match === "object" && match.invocation.status === "accepted";
}

export function isRejectedTriggerProviderMatch<TriggerContext, OutputContext>(
  match: TriggerProviderMatch<TriggerContext, OutputContext> | string | undefined,
): match is RejectedTriggerProviderMatch<TriggerContext, OutputContext> {
  return typeof match === "object" && match.invocation.status === "rejected";
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
  match(trigger: ExternalTrigger): Promise<TriggerProviderResult<TriggerContext, OutputContext>>;
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
