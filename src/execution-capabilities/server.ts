import { Ajv, type ErrorObject } from "ajv";
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
import { compileJsonSchema, formatJsonSchemaErrors } from "../workflows/json-schema.js";
import type { OutputExecutorRegistry } from "./outputs.js";

interface JsonSchemaNode {
  readonly [key: string]: JsonValue;
}

interface JsonSchema {
  type: "object";
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  [key: string]: unknown;
}

const FinishArgumentsSchema: JsonSchema = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};
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
      try {
        await server.connect(transport);
        return await transport.handleRequest(request);
      } finally {
        await server.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
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
  const ajv = new Ajv({ allErrors: true, strict: true });
  const finishContract = finishExecutionContract(execution.launchIntent?.outputSchema, ajv);
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
    contracts.set("reply", jsonSchemaContract(ReplyArgumentsSchema, ajv));
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
        const output = Object.hasOwn(args, "output") ? args["output"] : undefined;
        const completed = await options.completeExecution({
          executionId: execution.id,
          token,
          ...(output === undefined ? {} : { output }),
        });
        return completed.status === "succeeded"
          ? toolSuccess("Execution finished")
          : toolFailure("Execution could not be finished");
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

function finishExecutionContract(
  outputSchema: JsonValue | undefined,
  ajv: Ajv,
): JsonSchemaContract {
  if (outputSchema === undefined) return jsonSchemaContract(FinishArgumentsSchema, ajv);

  const outputValidator = compileJsonSchema(outputSchema).validate;
  const envelope = {
    type: "object" as const,
    required: ["output"],
    properties: { output: {} },
    additionalProperties: false,
  };
  const envelopeValidator = ajv.compile(envelope);
  const schema = {
    type: "object" as const,
    required: ["output"],
    properties: { output: schemaNode(structuredClone(outputSchema)) },
    additionalProperties: false,
  };
  return {
    schema,
    validate(args) {
      if (!envelopeValidator(args)) {
        return { valid: false, message: validationMessage(envelopeValidator.errors) };
      }
      if (!outputValidator(args["output"])) {
        return { valid: false, message: validationMessage(outputValidator.errors) };
      }
      return { valid: true };
    },
  };
}

function jsonSchemaContract(schema: JsonSchema, ajv: Ajv): JsonSchemaContract {
  const validator = ajv.compile(schema);
  return {
    schema,
    validate(args) {
      return validator(args)
        ? { valid: true }
        : { valid: false, message: validationMessage(validator.errors) };
    },
  };
}

function validationMessage(errors: readonly ErrorObject[] | null | undefined): string {
  const messages = formatJsonSchemaErrors(errors, "arguments");
  return messages.length === 0
    ? "Invalid arguments for tool"
    : `Invalid arguments for tool: ${messages.join("; ")}`;
}

function schemaNode(value: JsonValue): JsonSchemaNode {
  if (!isSchemaNode(value)) throw new Error("JSON Schema must be an object");
  return value;
}

function isSchemaNode(value: JsonValue): value is JsonSchemaNode {
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
