import type { ErrorObject } from "ajv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { verifyAgentExecutionCompletionToken } from "../agent-executions/completion-token.js";
import type { JsonValue } from "../config/compiler.js";
import type { AgentExecutionRecord, Database } from "../db/types.js";
import { registerResponseLifecycle } from "../http/response-lifecycle.js";
import {
  compileFinishExecutionArguments,
  compileJsonSchema,
  formatJsonSchemaErrors,
} from "../workflows/json-schema.js";
import type { MaterializedOutputCapability, OutputExecutorRegistry } from "./outputs.js";

interface JsonSchemaNode {
  readonly [key: string]: JsonValue;
}

interface JsonSchema extends JsonSchemaNode {
  readonly type: "object";
  readonly properties?: Record<string, JsonSchemaNode>;
  readonly required?: string[];
}

export interface ExecutionCapabilityServer {
  handle(request: Request, executionId: string): Promise<Response>;
}

interface ExecutionCapabilityOptions {
  database: Database;
  outputs: OutputExecutorRegistry;
  completeExecution(input: {
    executionId: string;
    token: string;
    output?: unknown;
  }): Promise<AgentExecutionRecord>;
  now?: () => Date;
}

export function createExecutionCapabilityServer(
  options: ExecutionCapabilityOptions,
): ExecutionCapabilityServer {
  return {
    async handle(request, executionId) {
      const token = readBearerToken(request.headers.get("authorization") ?? undefined);
      const execution = await authenticateExecution(options.database, executionId, token);
      if (execution === undefined) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (execution.status !== "spawning" && execution.status !== "running") {
        return Response.json({ error: "execution_not_live" }, { status: 409 });
      }
      let materializedOutputs: readonly MaterializedOutputCapability[];
      try {
        materializedOutputs = options.outputs.materialize(
          execution.launchIntent?.allowOutputs ?? [],
          execution.outputContext,
        );
      } catch (error) {
        return Response.json(
          {
            error: "required_output_capability_unavailable",
            message:
              error instanceof Error ? error.message : "required output capability unavailable",
          },
          { status: 409 },
        );
      }

      const server = createMcpServer(options, execution, token!, materializedOutputs);
      const transport = new WebStandardStreamableHTTPServerTransport({
        // Omitting sessionIdGenerator is the SDK's stateless-mode setting.
        enableJsonResponse: true,
        enableDnsRebindingProtection: false,
      });
      let responseLifecycleRegistered = false;
      const closeMcp = async (): Promise<void> => {
        await server.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      };
      try {
        await server.connect(transport);
        const response = await transport.handleRequest(request);
        responseLifecycleRegistered = true;
        return registerResponseLifecycle(response, {
          // HTTP finish only proves that Node flushed the MCP response. The
          // provider still has to acknowledge its subsequent turn before a
          // deferred Hub archive action can be reconciled.
          onFinish: closeMcp,
          onAbort: closeMcp,
        });
      } finally {
        if (!responseLifecycleRegistered) await closeMcp();
      }
    },
  };
}

async function authenticateExecution(
  database: Database,
  executionId: string,
  token: string | undefined,
): Promise<AgentExecutionRecord | undefined> {
  if (!z.uuid().safeParse(executionId).success || token === undefined) return undefined;
  const execution = await database.findAgentExecutionById(executionId);
  if (
    execution === undefined ||
    execution.completionTokenHash === null ||
    !verifyAgentExecutionCompletionToken(token, execution.completionTokenHash)
  ) {
    return undefined;
  }
  return execution;
}

function createMcpServer(
  options: {
    database: Database;
    outputs: OutputExecutorRegistry;
    completeExecution(input: {
      executionId: string;
      token: string;
      output?: unknown;
    }): Promise<AgentExecutionRecord>;
    now?: () => Date;
  },
  execution: AgentExecutionRecord,
  token: string,
  materializedOutputs: readonly MaterializedOutputCapability[],
): Server {
  const server = new Server(
    { name: "paseo-hub-execution", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const finishContract = finishExecutionContract(execution.launchIntent?.outputSchema);
  const tools: Tool[] = [
    {
      name: "finish_execution",
      description: "Mark this Hub execution complete after the task is fully finished.",
      inputSchema: finishContract.schema,
    },
  ];
  for (const output of materializedOutputs) {
    tools.push({
      name: output.capability.tool.name,
      description: `${output.capability.tool.description} (up to ${output.declaration.max} times).`,
      inputSchema: output.capability.tool.inputSchema,
    });
  }
  const contracts = new Map<string, JsonSchemaContract>([["finish_execution", finishContract]]);
  const outputsByToolName = new Map<string, MaterializedOutputCapability>();
  for (const output of materializedOutputs) {
    contracts.set(
      output.capability.tool.name,
      jsonSchemaContract(output.capability.tool.inputSchema),
    );
    outputsByToolName.set(output.capability.tool.name, output);
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const contract = contracts.get(toolName);
    if (contract === undefined) return toolFailure(`Tool ${toolName} not found`);
    const args = request.params.arguments ?? {};
    const validation = contract.validate(args);
    if (!validation.valid) return toolFailure(validation.message);

    if (toolName === "finish_execution")
      return finishExecutionCall(options, execution, token, args, materializedOutputs);
    const output = outputsByToolName.get(toolName);
    return output === undefined
      ? toolFailure(`Tool ${toolName} not found`)
      : executeOutputCall(options, execution, toolName, output, args);
  });
  return server;
}

async function finishExecutionCall(
  options: ExecutionCapabilityOptions,
  execution: AgentExecutionRecord,
  token: string,
  args: Record<string, unknown>,
  materializedOutputs: readonly MaterializedOutputCapability[],
) {
  try {
    const missingOutputs = missingRequiredOutputs(execution, materializedOutputs);
    if (missingOutputs.length > 0) return toolFailure(requiredOutputsGuidance(missingOutputs));
    const output = Object.hasOwn(args, "output") ? args["output"] : undefined;
    const completed = await options.completeExecution({
      executionId: execution.id,
      token,
      ...(output === undefined ? {} : { output }),
    });
    if (completed.status !== "succeeded") return toolFailure("Execution could not be finished");
    await options.database.recordAgentExecutionHubAcknowledgement(execution.id, {
      kind: "finish_execution",
      status: "completed",
      observedAt: options.now?.() ?? new Date(),
    });
    return toolSuccess("Execution finished");
  } catch (error) {
    return toolFailure(error instanceof Error ? error.message : "Execution could not be finished");
  }
}

async function executeOutputCall(
  options: ExecutionCapabilityOptions,
  execution: AgentExecutionRecord,
  toolName: string,
  output: MaterializedOutputCapability,
  args: Record<string, unknown>,
) {
  const attempt = await options.database.beginAgentExecutionOutput(
    execution.id,
    output.declaration.type,
    output.declaration.max,
    options.now?.() ?? new Date(),
  );
  if (attempt === undefined)
    return toolFailure(`Output limit reached for ${output.declaration.type}`);
  try {
    await options.outputs.execute({
      agentExecutionId: execution.id,
      attemptId: attempt.id,
      toolType: output.declaration.type,
      args,
      outputContext: execution.outputContext,
    });
    const recorded = await options.database.completeAgentExecutionOutput(
      execution.id,
      attempt.id,
      options.now?.() ?? new Date(),
    );
    if (recorded === undefined) throw new Error("output emission could not be recorded");
    return toolSuccess("Output sent");
  } catch {
    await options.database
      .failAgentExecutionOutput(execution.id, attempt.id, options.now?.() ?? new Date())
      .catch(() => undefined);
    return toolFailure(`Output delivery failed; retry \`${toolName}\`.`);
  }
}

interface JsonSchemaContract {
  schema: JsonSchema;
  validate(args: Record<string, unknown>): { valid: true } | { valid: false; message: string };
}

function finishExecutionContract(outputSchema: JsonValue | undefined): JsonSchemaContract {
  const compiled = compileFinishExecutionArguments(outputSchema);
  const schema = toolSchema(compiled.schema);
  return {
    schema,
    validate(args) {
      return compiled.validate(args)
        ? { valid: true }
        : {
            valid: false,
            message: validationMessage(compiled.validate.errors),
          };
    },
  };
}

function jsonSchemaContract(schema: JsonSchema): JsonSchemaContract {
  const compiled = compileJsonSchema(schema);
  return {
    schema,
    validate(args) {
      return compiled.validate(args)
        ? { valid: true }
        : {
            valid: false,
            message: validationMessage(compiled.validate.errors),
          };
    },
  };
}

function validationMessage(errors: readonly ErrorObject[] | null | undefined): string {
  const messages = formatJsonSchemaErrors(errors, "arguments");
  return messages.length === 0
    ? "Invalid arguments for tool"
    : `Invalid arguments for tool: ${messages.join("; ")}`;
}

function isSchemaNode(value: JsonValue): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolSchema(value: JsonValue): JsonSchema {
  if (!isToolSchema(value)) throw new Error("JSON Schema tool arguments must be an object");
  return value;
}

function isToolSchema(value: JsonValue): value is JsonSchema {
  if (!isSchemaNode(value) || value["type"] !== "object") return false;
  const properties = value["properties"];
  const required = value["required"];
  return (
    (properties === undefined ||
      (isRecord(properties) && Object.values(properties).every(isSchemaNode))) &&
    (required === undefined ||
      (Array.isArray(required) && required.every((item) => typeof item === "string")))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missingRequiredOutputs(
  execution: AgentExecutionRecord,
  materializedOutputs: readonly MaterializedOutputCapability[],
): readonly { type: string; toolName: string }[] {
  const toolsByType = new Map(
    materializedOutputs.map((output) => [output.declaration.type, output.capability.tool.name]),
  );
  return (execution.launchIntent?.allowOutputs ?? [])
    .filter((output) => output.required === true)
    .filter((output) => (execution.outputEmissions[output.type] ?? 0) < 1)
    .map((output) => ({
      type: output.type,
      toolName: toolsByType.get(output.type) ?? "unavailable",
    }));
}

function requiredOutputsGuidance(
  missingOutputs: readonly { type: string; toolName: string }[],
): string {
  const missing = missingOutputs
    .map((output) => `${output.type} (call \`${output.toolName}\`)`)
    .join(", ");
  return `Required output missing: ${missing}. Call the named Hub tool, then retry \`finish_execution\`.`;
}

function readBearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/u.exec(header ?? "");
  return match?.[1];
}

function toolSuccess(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function toolFailure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
