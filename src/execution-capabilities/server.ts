import { executionLinkUrl } from "../agent-executions/link.js";
import {
  callIntegrationTool,
  IntegrationToolError,
  type IntegrationToolHandlers,
} from "../integration-tools/index.js";
import type { ErrorObject } from "ajv";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  deriveAgentExecutionCompletionToken,
  verifyAgentExecutionCompletionToken,
} from "../agent-executions/completion-token.js";
import type { AgentSessionRecord } from "../agent-sessions/index.js";
import type { AgentExecutionRecord, Database } from "../db/types.js";
import { registerResponseLifecycle } from "../http/response-lifecycle.js";
import { reportFailure, withReference } from "../failures/index.js";
import { compileJsonSchema, formatJsonSchemaErrors } from "../workflows/json-schema.js";
import {
  executionToolDefinitions,
  finishExecutionToolName,
  replyOutputTool,
  type MaterializedOutputCapability,
  type OutputExecutorRegistry,
  type OutputToolSchema,
} from "./outputs.js";

type JsonSchema = OutputToolSchema;

export interface ExecutionCapabilityServer {
  handleSession(request: Request, sessionId: string): Promise<Response>;
  handle(request: Request, executionId: string): Promise<Response>;
}

interface ExecutionCapabilityOptions {
  completionTokenSecret?: string;
  publicBaseUrl?: string;
  database: Database;
  outputs: OutputExecutorRegistry;
  integrationTools?: IntegrationToolHandlers;
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
    async handleSession(request, sessionId) {
      const token = readBearerToken(request.headers.get("authorization") ?? undefined);
      const session = z.uuid().safeParse(sessionId).success
        ? await options.database.findAgentSession(sessionId)
        : undefined;
      if (
        !session ||
        !token ||
        !options.completionTokenSecret ||
        !verifyAgentExecutionCompletionToken(token, session.capabilityTokenHash)
      ) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const secret = options.completionTokenSecret;
      return serveMcp(request, sessionId, () => createSessionMcpServer(options, session, secret));
    },
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
        const failure = reportFailure(error, {
          operation: "execution_capability.materialize_outputs",
          component: "execution_capabilities",
          executionId,
        });
        return Response.json(
          {
            error: "required_output_capability_unavailable",
            message: withReference(outputCapabilityMessage(error), failure.requestId),
          },
          { status: 409 },
        );
      }

      return serveMcp(request, executionId, () =>
        createExecutionMcpServer(options, execution, token!, materializedOutputs),
      );
    },
  };
}

/**
 * Serves one MCP HTTP exchange. The handler answers both protocol eras from
 * fresh per-request servers: 2026-07-28 requests carry their protocol version
 * in a per-request envelope, and 2025-era clients that open with `initialize`
 * go through the SDK's stateless fallback. Nothing outlives the response.
 */
async function serveMcp(
  request: Request,
  resourceId: string,
  createServer: () => Server,
): Promise<Response> {
  const handler = createMcpHandler(createServer, { legacy: "stateless" });
  let responseLifecycleRegistered = false;
  const closeMcp = () => closeCapabilityResource("mcp_handler", resourceId, () => handler.close());
  try {
    const response = await handler.fetch(request);
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
}

function outputCapabilityMessage(error: unknown): string {
  if (error instanceof Error && error.name === "OutputCapabilityValidationError") {
    return error.message;
  }
  return "A required output capability is unavailable. Check the workflow output configuration.";
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

function createSessionMcpServer(
  options: ExecutionCapabilityOptions,
  session: AgentSessionRecord,
  completionTokenSecret: string,
): Server {
  const server = new Server(
    { name: "paseo-hub-session", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", () => ({
    tools: session.tools.map((tool) => ({
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          executionId: {
            type: "string",
            description: "Execution ID supplied with the request prompt.",
          },
        },
        required: [...(tool.inputSchema.required ?? []), "executionId"],
      },
    })),
  }));
  server.setRequestHandler("tools/call", async (call) => {
    const { executionId, ...args } = call.params.arguments ?? {};
    if (typeof executionId !== "string" || !z.uuid().safeParse(executionId).success)
      return toolFailure("A valid executionId is required");
    const execution = await options.database.findAgentExecutionById(executionId);
    if (
      !execution ||
      execution.agentSessionId !== session.id ||
      execution.organizationId !== session.organizationId ||
      execution.projectId !== session.projectId ||
      (execution.status !== "spawning" && execution.status !== "running")
    ) {
      return toolFailure("Execution is not live in this agent session");
    }
    const outputs = options.outputs.materialize(
      execution.launchIntent?.allowOutputs ?? [],
      execution.outputContext,
    );
    return callExecutionTool(
      options,
      execution,
      deriveAgentExecutionCompletionToken(completionTokenSecret, execution.id),
      outputs,
      call.params.name,
      args,
    );
  });
  return server;
}

function createExecutionMcpServer(
  options: ExecutionCapabilityOptions,
  execution: AgentExecutionRecord,
  token: string,
  materializedOutputs: readonly MaterializedOutputCapability[],
): Server {
  const server = new Server(
    { name: "paseo-hub-execution", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const tools = executionToolDefinitions(
    execution.launchIntent?.outputSchema,
    materializedOutputs,
    execution.launchIntent?.tools,
  );
  server.setRequestHandler("tools/list", () => ({ tools: [...tools] }));
  server.setRequestHandler("tools/call", (request) =>
    callExecutionTool(
      options,
      execution,
      token,
      materializedOutputs,
      request.params.name,
      request.params.arguments ?? {},
    ),
  );
  return server;
}

async function callExecutionTool(
  options: ExecutionCapabilityOptions,
  execution: AgentExecutionRecord,
  token: string,
  materializedOutputs: readonly MaterializedOutputCapability[],
  toolName: string,
  args: Record<string, unknown>,
) {
  try {
    const integration = await callIntegrationTool({
      name: toolName,
      organizationId: execution.organizationId,
      grants: execution.launchIntent?.tools,
      handlers: options.integrationTools,
      args,
    });
    if (integration !== undefined) return toolSuccess(JSON.stringify(integration.value));
  } catch (error) {
    if (error instanceof IntegrationToolError) return toolFailure(error.message);
    const failure = reportFailure(error, {
      operation: "execution_capability.integration_tool",
      component: "execution_capabilities",
      executionId: execution.id,
    });
    return toolFailure(withReference("The integration request failed.", failure.requestId));
  }
  const tool = executionToolDefinitions(
    execution.launchIntent?.outputSchema,
    materializedOutputs,
  ).find((candidate) => candidate.name === toolName);
  if (!tool) return toolFailure(`Tool ${toolName} not found`);
  const contract =
    toolName === finishExecutionToolName
      ? finishExecutionContract(tool.inputSchema)
      : jsonSchemaContract(tool.inputSchema);
  const validation = contract.validate(args);
  if (!validation.valid) return toolFailure(validation.message);
  if (toolName === finishExecutionToolName)
    return finishExecutionCall(options, execution, token, args, materializedOutputs);
  const output = materializedOutputs.find((item) => item.capability.tool.name === toolName);
  return output === undefined
    ? toolFailure(`Tool ${toolName} not found`)
    : executeOutputCall(options, execution, toolName, output, args);
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
    if (missingOutputs.length > 0) {
      reportFailure(
        new Error("required execution outputs are missing"),
        {
          operation: "execution_capability.finish.required_outputs",
          component: "execution_capabilities",
          executionId: execution.id,
        },
        { kind: "validation" },
      );
      return toolFailure(requiredOutputsGuidance(missingOutputs));
    }
    const output = Object.hasOwn(args, "output") ? args["output"] : undefined;
    const completed = await options.completeExecution({
      executionId: execution.id,
      token,
      ...(output === undefined ? {} : { output }),
    });
    if (completed.status !== "succeeded") {
      reportFailure(
        new Error(`execution completion ended with status ${completed.status}`),
        {
          operation: "execution_capability.finish.transition",
          component: "execution_capabilities",
          executionId: execution.id,
        },
        { kind: "conflict" },
      );
      return toolFailure(
        "Execution could not be finished because its state changed. Reload its current status before finishing again.",
      );
    }
    await options.database.recordAgentExecutionHubAcknowledgement(execution.id, {
      kind: "finish_execution",
      status: "completed",
      observedAt: options.now?.() ?? new Date(),
    });
    return toolSuccess("Execution finished");
  } catch (error) {
    const failure = reportFailure(error, {
      operation: "execution_capability.finish",
      component: "execution_capabilities",
      executionId: execution.id,
    });
    return toolFailure(
      withReference(
        "Execution could not be finished. Check its current status and required outputs.",
        failure.requestId,
      ),
    );
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
  if (attempt === undefined) {
    reportFailure(
      new Error("execution output limit reached"),
      {
        operation: "execution_capability.output.limit",
        component: "execution_capabilities",
        executionId: execution.id,
      },
      { kind: "conflict" },
    );
    return toolFailure(`Output limit reached for ${output.declaration.type}`);
  }
  try {
    const url =
      toolName === replyOutputTool.name
        ? executionLinkUrl(options.publicBaseUrl, execution)
        : undefined;
    await options.outputs.execute({
      agentExecutionId: execution.id,
      attemptId: attempt.id,
      ...(url === undefined ? {} : { openInPaseoUrl: url }),
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
  } catch (error) {
    const failure = reportFailure(error, {
      operation: "execution_capability.output.deliver",
      component: "execution_capabilities",
      executionId: execution.id,
    });
    try {
      await options.database.failAgentExecutionOutput(
        execution.id,
        attempt.id,
        options.now?.() ?? new Date(),
      );
    } catch (recordError) {
      reportFailure(recordError, {
        operation: "execution_capability.output.record_failure",
        component: "execution_capabilities",
        executionId: execution.id,
      });
    }
    return toolFailure(
      withReference(
        `Output delivery failed. Check the provider connection and output configuration before calling \`${toolName}\` again.`,
        failure.requestId,
      ),
    );
  }
}

async function closeCapabilityResource(
  resource: string,
  executionId: string,
  close: () => Promise<void>,
): Promise<void> {
  try {
    await close();
  } catch (error) {
    reportFailure(error, {
      operation: `execution_capability.${resource}.close`,
      component: "execution_capabilities",
      executionId,
    });
  }
}

interface JsonSchemaContract {
  schema: JsonSchema;
  validate(args: Record<string, unknown>): { valid: true } | { valid: false; message: string };
}

function finishExecutionContract(schema: JsonSchema): JsonSchemaContract {
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
