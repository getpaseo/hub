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
    "<system-tools>",
    "The following MCP tools are provided by Paseo Hub for this execution:",
    "",
    ...inventory.map((capability) => `- ${capability.name}: ${capability.description}`),
    "",
    "When instructed to use one of these tools, call the MCP tool directly. Do not print, describe, or return a tool call as ordinary text. Returning equivalent text or JSON does not invoke the tool.",
    "</system-tools>",
    "",
    input.prompt,
  ].join("\n");
}
