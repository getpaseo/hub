import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { missingRequiredOutputs } from "../execution-capabilities/required-outputs.js";
import type { AgentExecutionRecord, WorkflowDeadlineKind } from "./types.js";

/** Explicit cancellation wins over an elapsed idle deadline; hard deadlines remain authoritative. */
export function deadlineForWorkflowCompletion(
  deadlineKind: WorkflowDeadlineKind | undefined,
  executionStatus: "succeeded" | "failed",
): WorkflowDeadlineKind | undefined {
  return deadlineKind === "step_idle" && executionStatus === "failed" ? undefined : deadlineKind;
}

/**
 * An execution that delivered every explicitly required output and then went
 * quiet has done its job; it merely skipped `finish_execution`. Its idle
 * deadline therefore ends a successful execution rather than a failed one.
 *
 * Optional outputs are progress, not completion. When no output is required,
 * the execution must still call `finish_execution`.
 * Executions that owe a structured output are excluded: their success is the
 * validated output itself, which only `finish_execution` can deliver.
 */
export function completesAtIdleDeadline(execution: {
  outputEmissions: AgentExecutionRecord["outputEmissions"];
  launchIntent: Pick<LaunchMachineIntent, "outputSchema" | "allowOutputs"> | null;
}): boolean {
  const requiredOutputs =
    execution.launchIntent?.allowOutputs.filter((output) => output.required === true) ?? [];
  return (
    execution.launchIntent?.outputSchema === undefined &&
    requiredOutputs.length > 0 &&
    missingRequiredOutputs(execution).length === 0
  );
}
