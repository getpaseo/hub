import { createHash, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiKeyScope } from "../auth/api-key-contract.js";
import type { OperationAuthorization } from "../auth/api-keys.js";
import type { PublicApiComposition } from "../public-api/index.js";
import { DispatchManualRunRequestSchema } from "../public-api/contracts.js";
import type { PublicOperations } from "../public-operations/index.js";
import type { Database } from "../db/types.js";
import type { DaemonConnection } from "../daemons/protocol.js";
import { DaemonResponseLostError } from "../daemons/protocol.js";
import { DaemonAgentError } from "../daemons/agents/index.js";
import { TimelineCursorSchema } from "../daemons/agents/control.js";
import { registerResponseLifecycle } from "../http/response-lifecycle.js";
import { reportFailure } from "../failures/index.js";

interface Options {
  composition: PublicApiComposition;
  database: Pick<Database, "findDaemonForOrganization" | "listDaemonsForOrganization"> | null;
  connectionForDaemon(id: string): DaemonConnection | undefined;
  operations: Pick<PublicOperations, "listProjects" | "dispatchManualRun"> | null;
}
interface ToolDefinition {
  tool: Tool;
  scope: ApiKeyScope;
  invoke(access: OperationAuthorization, args: unknown): Promise<unknown>;
}
class McpOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const id = z.string().min(1).max(512);
const daemonInput = z.object({ daemonId: id });
const agentInput = daemonInput.extend({ agentId: id });
const pageInput = daemonInput.extend({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: id.optional(),
});
const createInput = daemonInput.extend({
  requestKey: id.describe(
    "Stable identity for this creation. Reuse it with identical arguments after a lost response.",
  ),
  cwd: id.describe("Repository root or directory on the chosen daemon, from list_workspaces."),
  provider: id,
  model: id.optional(),
  thinkingOptionId: id.optional(),
  modeId: id.describe(
    "Explicit provider-native permission mode from get_providers. Select its full-access mode when requested.",
  ),
  providerOptions: z.record(z.string(), z.json()).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().min(1).max(1_000_000),
  workspace: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("worktree"), newBranch: id.optional(), base: id.optional() }),
      z.object({ kind: z.literal("reuse"), workspaceId: id }),
      z.object({ kind: z.literal("directory") }),
    ])
    .default({ kind: "worktree" })
    .describe(
      "Default creates an isolated managed worktree. Reuse and directory explicitly share files.",
    ),
});

/** Organization credentials control ordinary daemon agents. Execution capability tokens cannot enter here. */
export function createHubMcp(options: Options): { handle(request: Request): Promise<Response> } {
  const definitions = toolsFor(options);
  return {
    async handle(request) {
      const requestId = randomUUID();
      if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
        return problem(405, "method_not_allowed", requestId, { allow: "POST, GET, DELETE" });
      }
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== new URL(request.url).origin)
        return problem(403, "origin_not_allowed", requestId);
      if (
        options.composition.status !== "enabled" ||
        options.database === null ||
        options.operations === null
      ) {
        return problem(503, "infrastructure_unavailable", requestId);
      }
      try {
        let access: OperationAuthorization | undefined;
        for (const scope of [
          "agents:read",
          "agents:control",
          "runs:dispatch",
          "projects:read",
        ] as const) {
          const authorization = await options.composition.authenticator.authorize(request, scope);
          if (authorization.status === "unauthorized")
            return problem(401, "unauthorized", requestId, { "www-authenticate": "Bearer" });
          if (authorization.status === "authorized") {
            access = authorization.access;
            break;
          }
        }
        if (access === undefined) return problem(403, "insufficient_scope", requestId);
        const authorized = access;
        const server = new Server(
          { name: "paseo-hub", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: definitions
            .filter((entry) => authorized.scopes.includes(entry.scope))
            .map((entry) => entry.tool),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (call) => {
          const definition = definitions.find((entry) => entry.tool.name === call.params.name);
          if (!definition) return failure("unknown_tool", "Unknown tool", requestId);
          if (!authorized.scopes.includes(definition.scope))
            return failure("insufficient_scope", `Requires ${definition.scope}`, requestId);
          try {
            const result = await definition.invoke(authorized, call.params.arguments ?? {});
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
          } catch (error) {
            if (error instanceof z.ZodError)
              return failure("invalid_arguments", JSON.stringify(error.issues), requestId);
            if (error instanceof McpOperationError)
              return failure(error.code, error.message, requestId);
            if (error instanceof DaemonResponseLostError)
              return failure(
                "daemon_response_lost",
                "The daemon may have accepted the request. Retry creation with the same requestKey or messages with the same messageKey and identical arguments.",
                requestId,
              );
            if (error instanceof DaemonAgentError)
              return failure("daemon_request_rejected", error.message, requestId);
            reportFailure(error, {
              component: "hub-mcp",
              operation: `hub-mcp.${call.params.name}`,
              requestId,
              organizationId: authorized.organizationId,
            });
            return failure(
              "operation_failed",
              "The operation failed. Contact the Hub operator with the request ID.",
              requestId,
            );
          }
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          enableDnsRebindingProtection: false,
        });
        const close = async () => {
          await server.close();
          await transport.close();
        };
        try {
          await server.connect(transport);
          const response = await transport.handleRequest(request);
          response.headers.set("cache-control", "no-store");
          response.headers.set("x-request-id", requestId);
          return registerResponseLifecycle(response, { onFinish: close, onAbort: close });
        } catch (error) {
          await close();
          throw error;
        }
      } catch (error) {
        reportFailure(error, { component: "hub-mcp", operation: "hub-mcp.handle", requestId });
        return problem(503, "infrastructure_unavailable", requestId);
      }
    },
  };
}

function toolsFor(options: Options): ToolDefinition[] {
  const tool = <T>(
    name: string,
    scope: ApiKeyScope,
    description: string,
    schema: z.ZodType<T>,
    invoke: (access: OperationAuthorization, input: T) => Promise<unknown>,
  ): ToolDefinition => ({
    tool: ToolSchema.parse({
      name,
      description,
      inputSchema: z.toJSONSchema(schema, { io: "input" }),
      annotations: {
        readOnlyHint: scope.endsWith(":read"),
        destructiveHint: name.startsWith("archive_"),
        openWorldHint: true,
      },
    }),
    scope,
    invoke: (access, args) => invoke(access, schema.parse(args)),
  });
  const connection = async (access: OperationAuthorization, daemonId: string) => {
    const daemon = await options.database?.findDaemonForOrganization(
      access.organizationId,
      daemonId,
    );
    if (daemon?.status !== "active")
      throw new McpOperationError(
        "daemon_unavailable",
        "Daemon is not active in this organization",
      );
    if (!daemon.permissions.includes("hub.execute"))
      throw new McpOperationError(
        "daemon_execution_not_allowed",
        "Daemon must explicitly grant hub.execute",
      );
    const result = options.connectionForDaemon(daemonId);
    if (!result) throw new McpOperationError("daemon_not_connected", "Daemon is offline");
    return result;
  };
  const agents = async (access: OperationAuthorization, daemonId: string) => {
    const result = (await connection(access, daemonId)).agentControl;
    if (!result)
      throw new McpOperationError(
        "daemon_control_unavailable",
        "Update the daemon to support agent control",
      );
    return result;
  };
  return [
    tool(
      "list_daemons",
      "agents:read",
      "List active daemons enrolled in this organization with hub.execute. No daemon credentials are returned.",
      z.object({}),
      async (access) => ({
        daemons: (await options.database!.listDaemonsForOrganization(access.organizationId))
          .filter((d) => d.status === "active" && d.permissions.includes("hub.execute"))
          .map((d) => ({
            id: d.id,
            slug: d.slug,
            connected: options.connectionForDaemon(d.id) !== undefined,
          })),
      }),
    ),
    tool(
      "get_providers",
      "agents:read",
      "Read provider-native models, thinking options, permission modes, and readiness on a daemon.",
      daemonInput.extend({ cwd: id.optional() }),
      async (access, input) =>
        (await connection(access, input.daemonId)).getProviderSnapshot(
          input.cwd === undefined ? {} : { cwd: input.cwd },
        ),
    ),
    tool(
      "list_workspaces",
      "agents:read",
      "List existing daemon workspaces and repository roots. Use pageInfo.nextCursor for additional pages.",
      pageInput,
      async (access, input) =>
        (await agents(access, input.daemonId)).workspaces({
          limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        }),
    ),
    tool(
      "list_agents",
      "agents:read",
      "List ordinary daemon agents, including agents created outside MCP. Use pageInfo.nextCursor for additional pages.",
      pageInput.extend({ includeArchived: z.boolean().default(false) }),
      async (access, input) =>
        (await agents(access, input.daemonId)).directory(
          { limit: input.limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) },
          input.includeArchived,
        ),
    ),
    tool(
      "get_agent",
      "agents:read",
      "Read current agent status, active turn, pending permission summaries, and errors. Idle means the turn ended, not that the task succeeded.",
      agentInput,
      async (access, input) => (await agents(access, input.daemonId)).details(input.agentId),
    ),
    tool(
      "get_agent_activity",
      "agents:read",
      "Read a bounded persisted timeline page including results. Poll direction=after with the previous endCursor; honor reset, staleCursor, gap, and hasNewer. Continues across MCP reconnections.",
      agentInput.extend({
        direction: z.enum(["tail", "before", "after"]).default("tail"),
        cursor: TimelineCursorSchema.optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      async (access, input) =>
        (await agents(access, input.daemonId)).activity(input.agentId, {
          direction: input.direction,
          limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        }),
    ),
    tool(
      "create_agent",
      "agents:control",
      "Start an ordinary daemon agent and its initial prompt, returning its IDs without waiting for task completion. Calls can run in parallel. Pass an explicit provider mode; worktree isolation is the default. Sessions and worktrees remain until explicit archive.",
      createInput,
      async (access, input) => {
        const control = await agents(access, input.daemonId);
        const key = receiptKey(access.organizationId, "create", input.requestKey);
        const workspace = input.workspace;
        const result = await control.create(key, {
          cwd: input.cwd,
          provider: input.provider,
          mode: input.modeId,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.thinkingOptionId === undefined
            ? {}
            : { thinkingOptionId: input.thinkingOptionId }),
          ...(input.providerOptions === undefined
            ? {}
            : { providerOptions: input.providerOptions }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(workspace.kind === "reuse" ? { workspaceId: workspace.workspaceId } : {}),
          ...(workspace.kind === "worktree"
            ? {
                worktree: {
                  mode: "branch-off" as const,
                  newBranch: workspace.newBranch ?? `hub/mcp-${key.slice(-24)}`,
                  ...(workspace.base === undefined ? {} : { base: workspace.base }),
                },
              }
            : {}),
          env: {},
          toolPolicy: { preapproved: [] },
        });
        await control.send(
          result.id,
          receiptKey(access.organizationId, "initial-message", input.requestKey),
          input.prompt,
        );
        return {
          daemonId: input.daemonId,
          agentId: result.id,
          workspaceId: result.workspaceId,
          promptAccepted: true,
        };
      },
    ),
    tool(
      "send_agent_message",
      "agents:control",
      "Start a new turn or steer a busy agent. Steer may fall back to interruption if the provider cannot steer. Explicit interrupt is available; no queue-until-idle behavior. Reuse messageKey with identical text for retries.",
      agentInput.extend({
        messageKey: id,
        text: z.string().min(1).max(1_000_000),
        activeTurnBehavior: z.enum(["steer", "interrupt"]).default("steer"),
      }),
      async (access, input) => {
        await (
          await agents(access, input.daemonId)
        ).message(
          input.agentId,
          receiptKey(access.organizationId, `message:${input.agentId}`, input.messageKey),
          input.text,
          input.activeTurnBehavior,
        );
        return { accepted: true, agentId: input.agentId };
      },
    ),
    tool(
      "interrupt_agent",
      "agents:control",
      "Interrupt the current turn and keep the session reusable. Does not cancel a related Hub workflow, which may remain active until completion or timeout.",
      agentInput,
      async (access, input) => {
        const control = await agents(access, input.daemonId);
        const agent = await control.get(input.agentId);
        await control.control(agent.id, agent.workspaceId, "interrupt");
        return { interrupted: true, agentId: agent.id };
      },
    ),
    tool(
      "archive_agent",
      "agents:control",
      "Archive one agent session. Does not archive its workspace or remove its worktree.",
      agentInput,
      async (access, input) => {
        await (await agents(access, input.daemonId)).archiveAgent(input.agentId);
        return { archived: true, agentId: input.agentId };
      },
    ),
    tool(
      "archive_workspace",
      "agents:control",
      "Archive a workspace and its agents. Paseo may force-remove the managed worktree, including dirty and untracked files; the Git branch remains. Preserve work before this explicit cleanup.",
      daemonInput.extend({ workspaceId: id }),
      async (access, input) => {
        await (await agents(access, input.daemonId)).archiveWorkspace(input.workspaceId);
        return { archived: true, workspaceId: input.workspaceId };
      },
    ),
    tool(
      "list_projects",
      "projects:read",
      "List active Hub projects for manual workflow dispatch.",
      z.object({}),
      (access) => options.operations!.listProjects(access),
    ),
    tool(
      "dispatch_manual_run",
      "runs:dispatch",
      "Dispatch an existing configured manual workflow through the same durable event path as the public API. deliveryKey deduplicates the event; inspect the returned status for rejections.",
      DispatchManualRunRequestSchema,
      (access, input) => options.operations!.dispatchManualRun(access, input),
    ),
  ];
}
function receiptKey(organizationId: string, operation: string, key: string): string {
  return `hub-mcp:${createHash("sha256")
    .update(JSON.stringify([organizationId, operation, key]))
    .digest("hex")}`;
}
function failure(code: string, message: string, requestId: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, message, requestId }) }],
  };
}
function problem(
  status: number,
  code: string,
  requestId: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { type: "about:blank", title: code, status, code, requestId },
    {
      status,
      headers: {
        "content-type": "application/problem+json",
        "cache-control": "no-store",
        "x-request-id": requestId,
        ...headers,
      },
    },
  );
}
