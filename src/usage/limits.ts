import type { UsageMeasure } from "./dashboard.js";

/** Whether adding one more unit would exceed this measure. */
export function atLimit(measure: UsageMeasure): boolean {
  return measure.limit !== null && measure.used >= measure.limit;
}

/** Whether current use is already beyond this measure. */
export function overLimit(measure: UsageMeasure): boolean {
  return measure.limit !== null && measure.used > measure.limit;
}
