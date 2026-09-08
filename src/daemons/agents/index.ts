import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  HubExecutionAgentStreamEventSchema,
  HubExecutionAgentSnapshotSchema,
} from "../../hub/protocol.js";
import type { DaemonCreateAgentOptions, DaemonAgentStreamEvent } from "../protocol.js";

const SnapshotSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: HubExecutionAgentSnapshotSchema.shape.status,
  archivedAt: z.unknown().optional(),
});
export type AgentSnapshot = z.infer<typeof SnapshotSchema>;
export type AgentEvent =
  | { type: "agent_update"; agent: AgentSnapshot; timestamp: string }
  | { type: "agent_stream"; agentId: string; event: DaemonAgentStreamEvent; timestamp: string };
export interface AgentConnection {
  create(key: string, options: DaemonCreateAgentOptions): Promise<AgentSnapshot>;
  get(agentId: string): Promise<AgentSnapshot>;
  send(agentId: string, messageId: string, text: string): Promise<void>;
  restore(workspaceId: string): Promise<boolean>;
  control(agentId: string, workspaceId: string, action: "interrupt" | "archive"): Promise<void>;
  watch(agentId: string, listener: (event: AgentEvent) => void): Promise<() => void>;
}

const EnvelopeSchema = z.object({
  type: z.literal("session"),
  message: z.object({
    type: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }),
});
const ResultSchema = z
  .object({ error: z.string().nullable().optional(), accepted: z.boolean().optional() })
  .passthrough();

export class DaemonAgentError extends Error {}

/** The ordinary daemon protocol. This channel knows nothing about Hub executions or triggers. */
export class DaemonAgents implements AgentConnection {
  private supported = false;
  private readonly pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private observing = false;
  constructor(private readonly sendFrame: (frame: string) => void) {}

  receive(value: unknown): boolean {
    const envelope = EnvelopeSchema.safeParse(value);
    if (!envelope.success) return false;
    const { type, payload } = envelope.data.message;
    if (type === "server_info" || (type === "status" && payload["status"] === "server_info")) {
      const features = z
        .object({ hubAgentRpc: z.literal(true), agentRequestReceipts: z.literal(true) })
        .safeParse(payload["features"]);
      this.supported = features.success;
      return false;
    }
    const requestId = payload["requestId"];
    const pending = typeof requestId === "string" ? this.pending.get(requestId) : undefined;
    if (pending) {
      if (type === "rpc_error" || payload["status"] === "agent_create_failed") {
        pending.reject(
          new DaemonAgentError(z.string().catch("Daemon request rejected").parse(payload["error"])),
        );
      } else pending.resolve(payload);
      return true;
    }
    if (type === "agent_update" && payload["kind"] === "upsert") {
      const agent = SnapshotSchema.safeParse(payload["agent"]);
      if (agent.success)
        this.emit(agent.data.id, { type, agent: agent.data, timestamp: new Date().toISOString() });
      return true;
    }
    if (type === "agent_stream") {
      const stream = z
        .object({
          agentId: z.string(),
          timestamp: z.string(),
          event: HubExecutionAgentStreamEventSchema,
        })
        .safeParse(payload);
      if (stream.success) this.emit(stream.data.agentId, { type, ...stream.data });
      return true;
    }
    return false;
  }

  close(): void {
    for (const pending of this.pending.values()) pending.reject(new Error("daemon_disconnected"));
    this.pending.clear();
    this.listeners.clear();
  }

  async create(key: string, options: DaemonCreateAgentOptions): Promise<AgentSnapshot> {
    const response = await this.request({
      type: "create_agent_request",
      idempotencyKey: key,
      config: {
        provider: options.provider,
        cwd: options.cwd,
        model: options.model,
        modeId: options.mode,
        thinkingOptionId: options.thinkingOptionId,
        providerOptions: options.providerOptions,
        mcpServers: options.mcpServers,
        toolPolicy: options.toolPolicy,
      },
      env: options.env,
      worktree: options.worktree,
    });
    return SnapshotSchema.parse(response["agent"]);
  }
  async get(agentId: string): Promise<AgentSnapshot> {
    const response = await this.request({ type: "fetch_agent_request", agentId });
    if (response["agent"] === null)
      throw new DaemonAgentError(
        "Continuation agent was deleted; use a new key or choose a new agent",
      );
    return SnapshotSchema.parse(response["agent"]);
  }
  async send(agentId: string, messageId: string, text: string): Promise<void> {
    await this.request({
      type: "send_agent_message_request",
      agentId,
      messageId,
      text,
      activeTurnBehavior: "steer",
    });
  }
  async restore(workspaceId: string): Promise<boolean> {
    const result = await this.request({ type: "workspace.recovery.inspect.request", workspaceId });
    const state = z
      .object({ kind: z.string(), reason: z.string().optional() })
      .parse(result["state"]);
    if (state.kind === "unavailable" && state.reason === "workspace_not_archived") return false;
    if (state.kind !== "recoverable")
      throw new DaemonAgentError(
        "Workspace cannot be restored; inspect its recovery state in Paseo",
      );
    await this.request({ type: "workspace.recovery.restore.request", workspaceId });
    return true;
  }
  async control(
    agentId: string,
    workspaceId: string,
    action: "interrupt" | "archive",
  ): Promise<void> {
    await this.request(
      action === "archive"
        ? { type: "archive_workspace_request", workspaceId }
        : { type: "cancel_agent_request", agentId },
    );
  }
  async watch(agentId: string, listener: (event: AgentEvent) => void): Promise<() => void> {
    const listeners = this.listeners.get(agentId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(agentId, listeners);
    try {
      if (!this.observing) {
        await this.request({
          type: "fetch_agents_request",
          subscribe: { subscriptionId: "hub-continuation" },
        });
        this.observing = true;
      }
      await this.request({
        type: "agent.timeline.set_subscription.request",
        agentIds: [...this.listeners.keys()],
      });
    } catch (error) {
      listeners.delete(listener);
      throw error;
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(agentId);
    };
  }
  private emit(agentId: string, event: AgentEvent): void {
    for (const listener of this.listeners.get(agentId) ?? []) listener(event);
  }
  private async request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.supported)
      throw new DaemonAgentError("Update the Paseo daemon to use agent continuation");
    const requestId = randomUUID();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        timeout = setTimeout(() => reject(new Error("Daemon request timed out")), 30_000);
        this.sendFrame(JSON.stringify({ type: "session", message: { ...message, requestId } }));
      });
      const parsed = ResultSchema.parse(result);
      if (parsed.error || parsed.accepted === false)
        throw new DaemonAgentError(parsed.error ?? "Daemon request rejected");
      return result;
    } finally {
      clearTimeout(timeout);
      this.pending.delete(requestId);
    }
  }
}
