import { parseConnectionTemplate } from "../config/connection-template.js";
import { createHash } from "node:crypto";
import type { Database, AgentExecutionRecord } from "../db/types.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { DaemonCreateAgentOptions } from "../daemons/protocol.js";
import type { AgentConnection, AgentEvent } from "../daemons/agents/index.js";
import {
  executionToolDefinitions,
  type OutputExecutorRegistry,
} from "../execution-capabilities/outputs.js";
import {
  deriveAgentExecutionCompletionToken,
  hashAgentExecutionCompletionToken,
} from "../agent-executions/completion-token.js";
import type { AgentSessionRecord } from "./types.js";
export type { AgentSessionRecord, AgentSessionAction } from "./types.js";

export class AgentSessionError extends Error {}

/** Owns session selection, delivery, and cleanup under the same existing database lock. */
export class AgentSessions {
  constructor(
    private readonly database: Database,
    private readonly secret: string,
    private readonly publicBaseUrl: string,
    private readonly outputs: OutputExecutorRegistry,
  ) {}

  async dispatch(input: {
    executionId: string;
    intent: LaunchMachineIntent;
    connection: AgentConnection;
    createOptions: () => Promise<DaemonCreateAgentOptions>;
    onEvent: (event: AgentEvent) => void;
  }): Promise<{
    agentId: string;
    unsubscribe: () => void;
    action: "created" | "continued" | "restored";
  }> {
    const policy = input.intent.continuation;
    if (!policy) throw new Error("Session dispatch requires continuation policy");
    if (
      policy.key !== null &&
      (input.intent.github !== undefined ||
        Object.values({ ...input.intent.environment.env, ...input.intent.env }).some(
          (value) => parseConnectionTemplate(value).length > 0,
        ))
    ) {
      throw new AgentSessionError(
        "Temporary environment credentials require New agent continuity. Existing agents cannot refresh their environment.",
      );
    }
    const id = sessionId(input.intent.projectId, policy.key ?? `execution:${input.executionId}`);
    return this.database.withAdvisoryLock(`agent-session:${id}`, async () => {
      const tools = executionToolDefinitions(
        input.intent.outputSchema,
        this.outputs.materialize(input.intent.allowOutputs, input.intent.outputContext),
      );
      const compatibility = fingerprint({ settings: policy.compatibility, tools });
      let session = await this.database.findAgentSession(id);
      if (session && session.compatibility !== compatibility) {
        throw new AgentSessionError(
          "Continuation settings differ from the existing agent; use a different key or choose a new agent",
        );
      }
      if (!session) {
        const options = await input.createOptions();
        const token = deriveAgentExecutionCompletionToken(this.secret, `session:${id}`);
        session = {
          id,
          projectId: input.intent.projectId,
          organizationId: input.intent.organizationId,
          continuationKey: policy.key,
          daemonId: input.intent.environment.daemonId,
          agentId: null,
          workspaceId: null,
          compatibility,
          tools,
          capabilityTokenHash: hashAgentExecutionCompletionToken(token),
          creationOptions: {
            ...options,
            mcpServers: {
              hub: {
                type: "http",
                url: new URL(`/agent-sessions/${id}/mcp`, this.publicBaseUrl).toString(),
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          },
        };
        await this.database.saveAgentSession(session);
      }
      await this.database.attachExecutionToSession(input.executionId, id);
      let action: "created" | "continued" | "restored" = "continued";
      if (session.agentId === null) {
        const agent = await input.connection.create(id, session.creationOptions);
        session = { ...session, agentId: agent.id, workspaceId: agent.workspaceId };
        await this.database.saveAgentSession(session);
        action = "created";
      }
      if (session.agentId === null || session.workspaceId === null)
        throw new Error("Session agent is missing");
      const agent = await input.connection.get(session.agentId);
      if (agent.archivedAt) {
        await input.connection.restore(session.workspaceId);
        action = "restored";
      }
      await this.database.attachAgentToExecution(
        input.executionId,
        session.daemonId,
        session.agentId,
      );
      await this.database.attachExecutionToSession(input.executionId, id, action);
      const unsubscribe = await input.connection.watch(session.agentId, input.onEvent);
      try {
        await input.connection.send(
          session.agentId,
          input.executionId,
          `Hub execution: ${input.executionId}\nUse this executionId for Hub tool calls for this request.\n\n${input.intent.prompt}`,
        );
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return { agentId: session.agentId, unsubscribe, action };
    });
  }

  async control(
    execution: AgentExecutionRecord,
    connection: AgentConnection,
    action: "interrupt" | "archive",
  ): Promise<void> {
    if (!execution.agentSessionId) throw new Error("Execution has no agent session");
    const id = execution.agentSessionId;
    await this.database.withAdvisoryLock(`agent-session:${id}`, async () => {
      const session = await this.database.findAgentSession(id);
      if (!session?.agentId || !session.workspaceId) return;
      const executions = await this.database.listAgentSessionExecutions(id);
      // A completed arrival cannot stop work belonging to a newer arrival.
      if (executions.some((item) => item.status === "spawning" || item.status === "running"))
        return;
      await connection.control(session.agentId, session.workspaceId, action);
    });
  }
}

function sessionId(projectId: string, key: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["agent-session", projectId, key]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
}
