import type { AgentConnection, AgentSnapshot } from "../../daemons/agents/index.js";
import type { DaemonConnection, DaemonCreateAgentOptions } from "../../daemons/protocol.js";

/** A daemon port fake: Hub exercises its actual session and execution lifecycle. */
export class ScheduleTestDaemon implements DaemonConnection {
  readonly launches: DaemonCreateAgentOptions[] = [];
  readonly prompts: string[] = [];
  private readonly agent: AgentSnapshot = {
    id: "schedule-agent",
    workspaceId: "schedule-workspace",
    status: "running",
  };
  readonly agents: AgentConnection = {
    create: async (_key, options) => {
      this.launches.push(options);
      return this.agent;
    },
    get: async () => this.agent,
    send: async (_id, _messageId, text) => {
      this.prompts.push(text);
    },
    restore: async () => true,
    control: async () => {},
    watch: async () => () => {},
  };
  async createAgent(options: DaemonCreateAgentOptions) {
    this.launches.push(options);
    return { id: this.agent.id };
  }
  async controlExecution() {}
  async getProviderSnapshot(): Promise<import("../../hub/protocol.js").HubProviderSnapshot> {
    throw new Error("Provider catalog is not used by this test daemon.");
  }
  async refreshProviderSnapshot() {}
  on() {
    return () => {};
  }
}
