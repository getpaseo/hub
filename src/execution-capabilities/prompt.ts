import type { JsonValue } from "../config/compiler.js";
import {
  executionToolDefinitions,
  type AllowedOutput,
  type OutputExecutorRegistry,
} from "./outputs.js";

export interface ExecutionPromptInput {
  prompt: string;
  injectToolInventory?: boolean;
  allowOutputs: readonly AllowedOutput[];
  outputContext: unknown;
  outputSchema?: JsonValue;
  capabilities: OutputExecutorRegistry;
}

export function composeExecutionPrompt(input: ExecutionPromptInput): string {
  if (input.injectToolInventory === false) return input.prompt;

  const inventory = executionToolDefinitions(
    input.outputSchema,
    input.capabilities.materialize(input.allowOutputs, input.outputContext),
  );
  return [
    "Capabilities available in this execution:",
    ...inventory.map((capability) => `- ${capability.name}: ${capability.description}`),
    "",
    input.prompt,
  ].join("\n");
}
