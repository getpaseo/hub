/**
 * Call this in the `default` branch of a switch over a value that should be exhaustive.
 * TypeScript treats the parameter as `never` if all cases are handled, so adding a new value
 * to the union turns this into a compile error at the switch site rather than a silent fallthrough.
 *
 * @param value The switch discriminant — TypeScript infers `never` if all cases are covered.
 * @param context Optional label for the error message, e.g. `"connectionTable"`.
 */
export function assertNever(value: never, context?: string): never {
  throw new Error(
    `Unhandled value${context === undefined ? "" : ` in ${context}`}: ${String(value)}`,
  );
}
