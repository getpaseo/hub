/**
 * The limit-aware UI an organization sees wherever a limit can be reached: the locked control at
 * a cap, the remedy this deployment offers, and the sidebar's execution meter. Nothing here knows
 * that billing exists — the remedy asks one capability probe — so it renders on a self-hosted
 * instance exactly as it does on a hosted one.
 */
export { atLimit, overLimit } from "../../usage/limits.js";
export {
  ExecutionMeter,
  executionMeterLabel,
  meteredExecutions,
  useExecutionMeter,
} from "./execution-meter.js";
export {
  LockedAction,
  useEntitlementRemedy,
  useOrganizationLimits,
  type EntitlementRemedy,
} from "./limits.js";
