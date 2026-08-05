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
  completeExecution(input: { executionId: string; token: string }): Promise<AgentExecutionRecord>;
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
    completeExecution(input: { executionId: string; token: string }): Promise<AgentExecutionRecord>;
    now?: () => Date;
  },
  execution: AgentExecutionRecord,
  token: string,
): McpServer {
  const server = new McpServer({ name: "paseo-hub-execution", version: "1.0.0" });
  server.registerTool(
    "finish_execution",
    {
      description: "Mark this Hub execution complete after the task is fully finished.",
      inputSchema: FinishArgumentsSchema,
    },
    async () => {
      try {
        const completed = await options.completeExecution({ executionId: execution.id, token });
        return completed.status === "succeeded"
          ? toolSuccess("Execution finished")
          : toolFailure("Execution could not be finished");
      } catch {
        return toolFailure("Execution could not be finished");
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
