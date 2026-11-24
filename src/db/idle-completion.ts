import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { missingRequiredOutputs } from "../execution-capabilities/required-outputs.js";
import type { AgentExecutionRecord } from "./types.js";

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
