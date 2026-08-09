import type { DurableProviderEvent } from "../db/types.js";
import type { WorktreeTarget } from "../config/index.js";
import type { JsonValue } from "../config/compiler.js";
import type { InvocationParseResult } from "./invocation.js";

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

export function isAcceptedTriggerProviderMatch<TriggerContext, OutputContext>(
  match: TriggerProviderMatch<TriggerContext, OutputContext> | undefined,
): match is AcceptedTriggerProviderMatch<TriggerContext, OutputContext> {
  return match !== undefined && match.invocation.status === "accepted";
}

export function isRejectedTriggerProviderMatch<TriggerContext, OutputContext>(
  match: TriggerProviderMatch<TriggerContext, OutputContext> | undefined,
): match is RejectedTriggerProviderMatch<TriggerContext, OutputContext> {
  return match !== undefined && match.invocation.status === "rejected";
}

export interface TriggerProviderLifecycleResult {
  status: "succeeded" | "failed";
  summary?: string;
}

export interface TriggerLaunchMaterialization<TriggerContext = unknown> {
  executionId: string;
  organizationId: string;
  projectId: string;
  environmentEnv?: Record<string, string>;
  environmentWorktree?: WorktreeTarget;
  triggerContext: TriggerContext;
}

export interface MaterializedTriggerLaunch {
  environmentEnv?: Record<string, string>;
  environmentWorktree?: WorktreeTarget;
}

export interface TriggerContextMaterialization<TriggerContext = unknown> {
  executionId: string;
  organizationId: string;
  projectId: string;
  triggerContext: TriggerContext;
}

export function asTriggerContextValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new Error("trigger context must be valid JSON");
  return value;
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
  materializeContext?(launch: TriggerContextMaterialization<TriggerContext>): Promise<unknown>;
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

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object" || value === null) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every(isJsonValue)
  );
}
