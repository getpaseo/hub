import type { AllowedOutput, OutputExecutorRegistry } from "./outputs.js";

export interface ExecutionPromptInput {
  prompt: string;
  injectToolInventory?: boolean;
  allowOutputs: readonly AllowedOutput[];
  outputContext: unknown;
  capabilities: OutputExecutorRegistry;
}

export function composeExecutionPrompt(input: ExecutionPromptInput): string {
  if (input.injectToolInventory === false) return input.prompt;

  const inventory = input.capabilities.availableCapabilities(
    input.allowOutputs,
    input.outputContext,
  );
  return [
    "Capabilities available in this execution:",
    ...inventory.map((capability) => `- ${capability.name}: ${capability.description}`),
    "",
    input.prompt,
  ].join("\n");
}
