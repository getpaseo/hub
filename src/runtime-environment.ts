import { config } from "dotenv";

export type RuntimeEnvironmentSource = "process-and-dotenv" | "process-only";

export function loadRuntimeEnvironment(source: RuntimeEnvironmentSource): void {
  if (source === "process-only") return;
  config();
}
