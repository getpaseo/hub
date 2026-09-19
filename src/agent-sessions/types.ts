import type { DaemonCreateAgentOptions } from "../daemons/protocol.js";
import type { OutputToolDefinition } from "../execution-capabilities/outputs.js";

export type AgentSessionAction = "created" | "continued" | "restored";

export interface AgentSessionRecord {
  id: string;
  organizationId: string;
  projectId: string;
  continuationKey: string | null;
  daemonId: string;
  agentId: string | null;
  workspaceId: string | null;
  compatibility: string;
  creationOptions: DaemonCreateAgentOptions;
  capabilityTokenHash: string;
  tools: readonly OutputToolDefinition[];
}
