import type { WorktreeTarget } from "../config/index.js";
import type { JsonValue } from "../config/compiler.js";
import type {
  HubExecutionAgentSnapshot,
  HubExecutionAgentStreamEvent,
  HubProviderSnapshot,
} from "../hub/protocol.js";

export interface DaemonCreateAgentOptions {
  provider: string;
  mode?: string;
  model?: string;
  thinkingOptionId?: string;
  providerOptions?: Readonly<Record<string, JsonValue>>;
  toolPolicy: ToolPolicy;
  cwd: string;
  env: Record<string, string>;
  mcpServers?: Record<string, McpHttpServerConfig>;
  worktree?: WorktreeTarget;
  workspaceAffinity?: {
    key: string;
    retainUntil: string;
    autoArchive: boolean;
  };
}

export interface McpToolRef {
  kind: "mcp";
  server: "hub";
  tool: string;
}

export interface ToolPolicy {
  preapproved: readonly McpToolRef[];
}

export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export type DaemonTimelineItem = Extract<
  HubExecutionAgentStreamEvent,
  { type: "timeline" }
>["item"];

export type DaemonAgentStreamEvent = HubExecutionAgentStreamEvent;

export interface DaemonAgentStreamDaemonEvent {
  type: "agent_stream";
  executionId: string;
  agentId: string;
  event: DaemonAgentStreamEvent;
  timestamp: string;
}

export interface DaemonAgentUpdateEvent {
  type: "agent_update";
  executionId: string;
  agentId: string;
  agent: HubExecutionAgentSnapshot;
  timestamp: string;
}

export type DaemonEvent = DaemonAgentStreamDaemonEvent | DaemonAgentUpdateEvent;

export interface DaemonConnection {
  agents: import("./agents/index.js").AgentConnection;
  getProviderSnapshot(options: { cwd?: string }): Promise<HubProviderSnapshot>;
  refreshProviderSnapshot(options: { cwd?: string; providers?: string[] }): Promise<void>;
}

/** A durable daemon request may have succeeded before its acknowledgement was lost. */
export class DaemonResponseLostError extends Error {
  constructor() {
    super("daemon response was lost");
    this.name = "DaemonResponseLostError";
  }
}
