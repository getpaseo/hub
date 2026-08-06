import type { JsonValue } from "../config/compiler.js";

export interface AllowedOutput {
  type: string;
  max: number;
  required?: boolean;
}

export interface OutputToolSchemaNode {
  readonly [key: string]: JsonValue;
}

export interface OutputToolSchema extends OutputToolSchemaNode {
  readonly type: "object";
  readonly properties?: Record<string, OutputToolSchemaNode>;
  readonly required?: string[];
}

export interface OutputToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: OutputToolSchema;
}

export interface OutputExecutionInput {
  agentExecutionId: string;
  attemptId?: string;
  toolType: string;
  args: Record<string, unknown>;
  outputContext: unknown;
}

export type OutputExecutor = (input: OutputExecutionInput) => Promise<void>;

export interface OutputCapability {
  readonly type: string;
  readonly tool: OutputToolDefinition;
  readonly available?: (outputContext: unknown) => boolean;
  readonly execute: OutputExecutor;
}

export interface MaterializedOutputCapability {
  readonly declaration: AllowedOutput;
  readonly capability: OutputCapability;
}

export const replyOutputTool: OutputToolDefinition = {
  name: "reply",
  description: "Reply to the conversation that triggered this execution.",
  inputSchema: {
    type: "object",
    properties: { content: { type: "string", minLength: 1 } },
    required: ["content"],
    additionalProperties: false,
  },
};

export function outputContextProvider(provider: string): (outputContext: unknown) => boolean {
  return (outputContext) =>
    typeof outputContext === "object" &&
    outputContext !== null &&
    Reflect.get(outputContext, "provider") === provider;
}

export class OutputCapabilityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputCapabilityValidationError";
  }
}

export class OutputExecutorRegistry {
  private readonly capabilities = new Map<string, OutputCapability>();

  register(capability: OutputCapability): void {
    if (capability.type.length === 0) throw new Error("output capability type is required");
    if (capability.tool.name.length === 0) {
      throw new Error(`output capability tool name is required: ${capability.type}`);
    }
    if (this.capabilities.has(capability.type)) {
      throw new Error(`output capability is already registered: ${capability.type}`);
    }
    this.capabilities.set(capability.type, capability);
  }

  validateRequiredOutputs(allowedOutputs: readonly AllowedOutput[], outputContext: unknown): void {
    const unavailable = allowedOutputs
      .filter((output) => output.required === true)
      .filter((output) => !this.isAvailable(output.type, outputContext))
      .map((output) => output.type);
    if (unavailable.length > 0) {
      throw new OutputCapabilityValidationError(
        `required output capability unavailable: ${unavailable.join(", ")}; register a Hub output tool for each type or remove required: true`,
      );
    }
  }

  materialize(
    allowedOutputs: readonly AllowedOutput[],
    outputContext: unknown,
  ): readonly MaterializedOutputCapability[] {
    this.validateRequiredOutputs(allowedOutputs, outputContext);
    const materialized = allowedOutputs.flatMap((declaration) => {
      const capability = this.capabilities.get(declaration.type);
      return capability !== undefined && this.isAvailable(declaration.type, outputContext)
        ? [{ declaration, capability }]
        : [];
    });
    const byToolName = new Map<string, MaterializedOutputCapability>();
    for (const output of materialized) {
      const previous = byToolName.get(output.capability.tool.name);
      if (previous !== undefined && previous.declaration.type !== output.declaration.type) {
        throw new OutputCapabilityValidationError(
          `output capabilities ${previous.declaration.type} and ${output.declaration.type} both expose Hub tool ${output.capability.tool.name}; register unique tool names`,
        );
      }
      byToolName.set(output.capability.tool.name, output);
    }
    return materialized;
  }

  private isAvailable(type: string, outputContext: unknown): boolean {
    const capability = this.capabilities.get(type);
    return capability !== undefined && (capability.available?.(outputContext) ?? true);
  }

  async execute(input: OutputExecutionInput): Promise<void> {
    const capability = this.capabilities.get(input.toolType);
    if (capability === undefined) {
      throw new Error(`no output executor registered for ${input.toolType}`);
    }
    await capability.execute(input);
  }
}
