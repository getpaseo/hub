import type { AgentExecutionRecord } from "../db/types.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { AllowedOutput } from "./outputs.js";

/** Failure reason of an execution finished while a required output had only failed deliveries. */
export const OUTPUT_DELIVERY_FAILED_REASON = "output_delivery_failed";

export interface OutputEmissionState {
  outputEmissions: AgentExecutionRecord["outputEmissions"];
  launchIntent: Pick<LaunchMachineIntent, "allowOutputs"> | null;
}

export interface OutputDeliveryState extends OutputEmissionState {
  outputDeliveryAttempts: AgentExecutionRecord["outputDeliveryAttempts"];
}

export interface RequiredOutputDeliveryFailure {
  type: string;
  failedAttempts: number;
}

/**
 * The `required: true` outputs the execution has not delivered yet. Delivery
 * means a completed attempt: `outputEmissions` only counts attempts that
 * succeeded, so an output whose every attempt failed is still missing here.
 * This is the single definition of "the execution still owes an output":
 * `finish_execution` refuses while it is non-empty, and the idle deadline must
 * not complete an execution that `finish_execution` would have refused.
 */
export function missingRequiredOutputs(execution: OutputEmissionState): readonly AllowedOutput[] {
  return (execution.launchIntent?.allowOutputs ?? [])
    .filter((output) => output.required === true)
    .filter((output) => (execution.outputEmissions[output.type] ?? 0) < 1);
}

/**
 * The required outputs still missing after at least one delivery attempt
 * failed. The agent did its part and the provider refused, so sending it back
 * to the same tool delivers nothing: an explicit completion ends the execution
 * as failed with `OUTPUT_DELIVERY_FAILED_REASON` instead of recording a success
 * nobody received.
 */
export function failedRequiredOutputDeliveries(
  execution: OutputDeliveryState,
): readonly RequiredOutputDeliveryFailure[] {
  return missingRequiredOutputs(execution).flatMap((output) => {
    const failedAttempts = Object.values(execution.outputDeliveryAttempts).filter(
      (attempt) => attempt.outputType === output.type && attempt.status === "failed",
    ).length;
    return failedAttempts === 0 ? [] : [{ type: output.type, failedAttempts }];
  });
}

/** `linear.reply after 3 failed attempts`, for the tool error the agent reads. */
export function describeRequiredOutputDeliveryFailures(
  failures: readonly RequiredOutputDeliveryFailure[],
): string {
  return failures
    .map(
      (failure) =>
        `${failure.type} after ${failure.failedAttempts} failed attempt${
          failure.failedAttempts === 1 ? "" : "s"
        }`,
    )
    .join(", ");
}
