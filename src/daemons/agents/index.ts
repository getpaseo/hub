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
export interface AgentStartup {
  key: string;
  deadlineAt: string;
  signal: AbortSignal;
}
export interface AgentConnection {
  inspectOperation(
    key: string,
    creationKey: string,
    signal?: AbortSignal,
  ): Promise<{ agentId: string | null; outcome: "settled" | "pending" | "unknown" }>;
  cancelOperation(
    key: string,
    creationKey: string,
    signal?: AbortSignal,
  ): Promise<{ agentId: string | null; outcome: "settled" | "pending" | "unknown" }>;
  create(
    key: string,
    options: DaemonCreateAgentOptions,
    startup?: AgentStartup,
  ): Promise<AgentSnapshot>;
  get(agentId: string, signal?: AbortSignal): Promise<AgentSnapshot>;
  send(agentId: string, messageId: string, text: string, startup?: AgentStartup): Promise<void>;
  restore(workspaceId: string, startup?: AgentStartup): Promise<boolean>;
  control(
    agentId: string,
    workspaceId: string,
    action: "interrupt" | "archive",
    operationKey?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  watch(
    agentId: string,
    listener: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<() => void>;
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
export class DaemonRequestTimeoutError extends Error {
  constructor() {
    super("Daemon request timed out");
  }
}

/** The ordinary daemon protocol. This channel knows nothing about Hub executions or triggers. */
export class DaemonAgents implements AgentConnection {
  private supported = false;
  private cancellationSupported = false;
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
      this.cancellationSupported = z
        .object({ agentRequestCancellation: z.literal(true) })
        .safeParse(payload["features"]).success;
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

  async create(
    key: string,
    options: DaemonCreateAgentOptions,
    startup?: AgentStartup,
  ): Promise<AgentSnapshot> {
    const response = await this.request(
      {
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
      },
      startup,
    );
    return SnapshotSchema.parse(response["agent"]);
  }
  async get(agentId: string, signal?: AbortSignal): Promise<AgentSnapshot> {
    const response = await this.request(
      { type: "fetch_agent_request", agentId },
      undefined,
      signal,
    );
    if (response["agent"] === null)
      throw new DaemonAgentError(
        "Continuation agent was deleted; use a new key or choose a new agent",
      );
    return SnapshotSchema.parse(response["agent"]);
  }
  async send(
    agentId: string,
    messageId: string,
    text: string,
    startup?: AgentStartup,
  ): Promise<void> {
    await this.request(
      {
        type: "send_agent_message_request",
        agentId,
        messageId,
        text,
        activeTurnBehavior: "steer",
      },
      startup,
    );
  }
  async restore(workspaceId: string, startup?: AgentStartup): Promise<boolean> {
    const result = await this.request(
      { type: "workspace.recovery.inspect.request", workspaceId },
      undefined,
      startup?.signal,
    );
    const state = z
      .object({ kind: z.string(), reason: z.string().optional() })
      .parse(result["state"]);
    if (state.kind === "unavailable" && state.reason === "workspace_not_archived") return false;
    if (state.kind !== "recoverable")
      throw new DaemonAgentError(
        "Workspace cannot be restored; inspect its recovery state in Paseo",
      );
    await this.request({ type: "workspace.recovery.restore.request", workspaceId }, startup);
    return true;
  }
  async control(
    agentId: string,
    workspaceId: string,
    action: "interrupt" | "archive",
    operationKey?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      action === "archive"
        ? {
            type: "archive_workspace_request",
            workspaceId,
            ...(operationKey ? { operation: { key: operationKey } } : {}),
          }
        : {
            type: "cancel_agent_request",
            agentId,
            ...(operationKey ? { operation: { key: operationKey } } : {}),
          },
      undefined,
      signal,
    );
  }
  async watch(
    agentId: string,
    listener: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<() => void> {
    const listeners = this.listeners.get(agentId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(agentId, listeners);
    try {
      if (!this.observing) {
        await this.request(
          {
            type: "fetch_agents_request",
            subscribe: { subscriptionId: "hub-continuation" },
          },
          undefined,
          signal,
        );
        this.observing = true;
      }
      await this.request(
        {
          type: "agent.timeline.set_subscription.request",
          agentIds: [...this.listeners.keys()],
        },
        undefined,
        signal,
      );
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
  async inspectOperation(key: string, creationKey: string, signal?: AbortSignal) {
    this.requireCancellation();
    const response = await this.request(
      { type: "agent.requests.inspect.request", key, creationKey },
      undefined,
      signal,
    );
    return z
      .object({
        agentId: z.string().nullable(),
        outcome: z.enum(["settled", "pending", "unknown"]),
      })
      .parse(response);
  }
  async cancelOperation(key: string, creationKey: string, signal?: AbortSignal) {
    this.requireCancellation();
    const response = await this.request(
      { type: "agent.requests.cancel.request", key, creationKey },
      undefined,
      signal,
    );
    return z
      .object({
        agentId: z.string().nullable(),
        outcome: z.enum(["settled", "pending", "unknown"]),
      })
      .parse(response);
  }
  private requireCancellation(): void {
    if (!this.cancellationSupported)
      throw new DaemonAgentError("Update the Paseo daemon to use cancelable agent startup");
  }
  private async request(
    message: Record<string, unknown>,
    startup?: AgentStartup,
    signal = startup?.signal,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    if (startup) this.requireCancellation();
    if (!this.supported)
      throw new DaemonAgentError("Update the Paseo daemon to use agent continuation");
    const requestId = randomUUID();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        if (signal) {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        }
        if (!startup) timeout = setTimeout(() => reject(new DaemonRequestTimeoutError()), 30_000);
        this.sendFrame(
          JSON.stringify({
            type: "session",
            message: {
              ...message,
              requestId,
              ...(startup
                ? { operation: { key: startup.key, deadlineAt: startup.deadlineAt } }
                : {}),
            },
          }),
        );
      });
      const parsed = ResultSchema.parse(result);
      if (parsed.error || parsed.accepted === false)
        throw new DaemonAgentError(parsed.error ?? "Daemon request rejected");
      return result;
    } finally {
      clearTimeout(timeout);
      if (abort) signal?.removeEventListener("abort", abort);
      this.pending.delete(requestId);
    }
  }
}
