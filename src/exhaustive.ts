// Adding a union member must fail typecheck at every exhaustive dispatch.
export function assertNever(value: never, context?: string): never {
  throw new Error(
    `Unhandled value${context === undefined ? "" : ` in ${context}`}: ${String(value)}`,
  );
}
