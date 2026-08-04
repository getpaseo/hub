import type { TriggerProvider, TriggerProviderLifecycleResult } from "./index.js";

export async function notifyAgentExecutionStarted(input: {
  provider: TriggerProvider;
  triggerContext: unknown;
  outputContext: unknown;
}): Promise<void> {
  await input.provider.onAgentExecutionStarted?.(input.triggerContext, input.outputContext);
}

export async function notifyAgentExecutionCompleted(input: {
  provider: TriggerProvider;
  triggerContext: unknown;
  outputContext: unknown;
  result: TriggerProviderLifecycleResult;
}): Promise<void> {
  await input.provider.onAgentExecutionCompleted?.(
    input.triggerContext,
    input.outputContext,
    input.result,
  );
}

export async function notifyAgentExecutionFailed(input: {
  provider: TriggerProvider;
  triggerContext: unknown;
  outputContext: unknown;
  reason: string;
}): Promise<void> {
  await input.provider.onAgentExecutionFailed?.(
    input.triggerContext,
    input.outputContext,
    input.reason,
  );
}

export async function notifyAgentExecutionTerminal(input: {
  provider: TriggerProvider;
  executionId: string;
  triggerContext: unknown;
}): Promise<void> {
  await input.provider.onAgentExecutionTerminal?.(input.executionId, input.triggerContext);
}

export async function notifyMachineTerminated(input: {
  provider: TriggerProvider;
  triggerContext: unknown;
  reason: string;
}): Promise<void> {
  await input.provider.onMachineTerminated?.(input.triggerContext, input.reason);
}
