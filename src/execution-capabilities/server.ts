import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { verifyAgentExecutionCompletionToken } from "../agent-executions/completion-token.js";
import type { AgentExecutionRecord, Database } from "../db/types.js";
import type { OutputExecutorRegistry } from "./outputs.js";

const FinishArgumentsSchema = z.object({}).strict();
const ReplyArgumentsSchema = z.object({ content: z.string().min(1) }).strict();

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
): McpServer {
  const server = new McpServer({ name: "paseo-hub-execution", version: "1.0.0" });
  const finishSchema =
    execution.launchIntent?.outputSchema === undefined
      ? FinishArgumentsSchema
      : z.object({ output: jsonSchemaToZod(execution.launchIntent.outputSchema) }).strict();
  server.registerTool(
    "finish_execution",
    {
      description: "Mark this Hub execution complete after the task is fully finished.",
      inputSchema: finishSchema,
    },
    async (args) => {
      try {
        const output = isRecord(args) && Object.hasOwn(args, "output") ? args["output"] : undefined;
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
    },
  );

  const replyOutput = allowedReplyOutput(execution);
  if (replyOutput !== undefined) {
    server.registerTool(
      "reply",
      {
        description: `Reply to the conversation that triggered this execution (up to ${replyOutput.max} times).`,
        inputSchema: ReplyArgumentsSchema,
      },
      async (args) => {
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
      },
    );
  }
  return server;
}

function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!isRecord(schema)) return z.any();
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const stringValues = enumValues.filter((value): value is string => typeof value === "string");
    if (stringValues.length === enumValues.length) {
      const enumObject = Object.fromEntries(
        stringValues.map((value, index) => [`value${index}`, value]),
      );
      return z.nativeEnum(enumObject);
    }
    return z
      .any()
      .refine(
        (value: unknown) =>
          enumValues.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value)),
        {
          message: "must match one of the configured enum values",
        },
      );
  }
  if (schema["const"] !== undefined) {
    const constant = schema["const"];
    return z.any().refine((value: unknown) => JSON.stringify(value) === JSON.stringify(constant), {
      message: "must equal the configured constant",
    });
  }
  const type = schema["type"];
  if (type === "object" || schema["properties"] !== undefined) return jsonObjectSchemaToZod(schema);
  if (type === "array") return jsonArraySchemaToZod(schema);
  if (type === "string") return z.string();
  if (type === "number" || type === "integer") return z.number();
  if (type === "boolean") return z.boolean();
  if (type === "null") return z.null();
  return z.any();
}

function jsonObjectSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const required = new Set(
    Array.isArray(schema["required"])
      ? schema["required"].filter((name): name is string => typeof name === "string")
      : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, child] of Object.entries(properties)) {
    const childSchema = jsonSchemaToZod(child);
    shape[name] = required.has(name) ? childSchema : childSchema.optional();
  }
  const object = z.object(shape);
  return schema["additionalProperties"] === false ? object.strict() : object;
}

function jsonArraySchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const items = schema["items"];
  return z.array(items === undefined ? z.any() : jsonSchemaToZod(items));
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
