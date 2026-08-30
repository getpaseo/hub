import type { Result } from "../../../contract/respond.js";

export function resultError(
  ...values: Array<Result<unknown> | Error | null | undefined>
): string | null {
  for (const value of values) {
    if (value instanceof Error) return value.message;
    if (value?.status === "error") return value.error.message;
  }
  return null;
}
