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
import type { OutputExecutorRegistry } from "./outputs.js";

interface JsonSchemaNode {
  readonly [key: string]: JsonValue;
}

interface JsonSchema extends JsonSchemaNode {
  readonly type: "object";
  readonly properties?: Record<string, JsonSchemaNode>;
  readonly required?: string[];
}

const ReplyArgumentsSchema: JsonSchema = {
  type: "object" as const,
  properties: { content: { type: "string", minLength: 1 } },
  required: ["content"],
  additionalProperties: false,
};

export interface ExecutionCapabilityServer {
  handle(request: Request, executionId: string): Promise<Response>;
}

export function createExecutionCapabilityServer(options: {
  database: Database;
  outputs: OutputExecutorRegistry;
  completeExecution(input: {
    executionId: string;
    token: string;
    output?: unknown;
  }): Promise<AgentExecutionRecord>;
  now?: () => Date;
}): ExecutionCapabilityServer {
  return {
    async handle(request, executionId) {
      const token = readBearerToken(request.headers.get("authorization") ?? undefined);
      const execution = await authenticateExecution(options.database, executionId, token);
      if (execution === undefined) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (execution.status !== "spawning" && execution.status !== "running") {
        return Response.json({ error: "execution_not_live" }, { status: 409 });
      }

      const server = createMcpServer(options, execution, token!);
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
  const replyOutput = allowedReplyOutput(execution);
  if (replyOutput !== undefined) {
    tools.push({
      name: "reply",
      description: `Reply to the conversation that triggered this execution (up to ${replyOutput.max} times).`,
      inputSchema: ReplyArgumentsSchema,
    });
  }
  const contracts = new Map<string, JsonSchemaContract>([["finish_execution", finishContract]]);
  if (replyOutput !== undefined) {
    contracts.set("reply", jsonSchemaContract(ReplyArgumentsSchema));
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const contract = contracts.get(toolName);
    if (contract === undefined) return toolFailure(`Tool ${toolName} not found`);
    const args = request.params.arguments ?? {};
    const validation = contract.validate(args);
    if (!validation.valid) return toolFailure(validation.message);

    if (toolName === "finish_execution") {
      try {
        const missingOutputs = missingRequiredOutputs(execution);
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
        return toolFailure(
          error instanceof Error ? error.message : "Execution could not be finished",
        );
      }
    }

    if (replyOutput === undefined) return toolFailure(`Tool ${toolName} not found`);
    const claimed = await options.database.claimAgentExecutionReply(
      execution.id,
      replyOutput.max,
      options.now?.() ?? new Date(),
    );
    if (!claimed) return toolFailure("Reply limit reached");
    try {
      await options.outputs.execute({
        agentExecutionId: execution.id,
        toolType: replyOutput.type,
        args,
        outputContext: execution.outputContext,
      });
      const recorded = await options.database.recordAgentExecutionOutput(
        execution.id,
        replyOutput.type,
      );
      if (recorded === undefined) throw new Error("output emission could not be recorded");
      return toolSuccess("Reply sent");
    } catch {
      return toolFailure("Reply delivery failed; the reply claim remains consumed");
    }
  });
  return server;
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

function allowedReplyOutput(
  execution: AgentExecutionRecord,
): { type: "slack.reply" | "discord.reply"; max: number } | undefined {
  const provider = readProvider(execution.outputContext);
  let type: "slack.reply" | "discord.reply" | undefined;
  if (provider === "slack") type = "slack.reply";
  if (provider === "discord") type = "discord.reply";
  if (type === undefined) return undefined;
  const output = execution.launchIntent?.allowOutputs.find((candidate) => candidate.type === type);
  return output === undefined ? undefined : { type, max: output.max };
}

function missingRequiredOutputs(execution: AgentExecutionRecord): readonly { type: string }[] {
  return (execution.launchIntent?.allowOutputs ?? [])
    .filter((output) => output.required === true)
    .filter((output) => (execution.outputEmissions[output.type] ?? 0) < 1)
    .map((output) => ({ type: output.type }));
}

function requiredOutputsGuidance(missingOutputs: readonly { type: string }[]): string {
  const missing = missingOutputs
    .map((output) => `${output.type} (call \`${outputToolName(output.type)}\`)`)
    .join(", ");
  return `Required output missing: ${missing}. Emit the required output with the named Hub tool, then retry \`finish_execution\`.`;
}

function outputToolName(outputType: string): string {
  const suffix = outputType.slice(outputType.lastIndexOf(".") + 1);
  return suffix.length === 0 ? outputType : suffix;
}

function readProvider(value: unknown): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, "provider") : undefined;
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
