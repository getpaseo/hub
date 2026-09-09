import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { AgentSessions } from "./index.js";
import { createMemoryDatabase } from "../db/memory.js";
import { OutputExecutorRegistry, replyOutputTool } from "../execution-capabilities/outputs.js";
import { createExecutionCapabilityServer } from "../execution-capabilities/server.js";
import type { AgentConnection, AgentSnapshot, AgentStartup } from "../daemons/agents/index.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { DaemonCreateAgentOptions } from "../daemons/protocol.js";

class TestAgents implements AgentConnection {
  private readonly creationKeys = new Map<string, AgentSnapshot>();
  private heldPhase: "create" | "restore" | "send" | "control" | undefined;
  private phaseStarted!: () => void;
  private phaseReleased!: () => void;
  private phaseGate: Promise<void> | undefined;
  private pendingStartup: string | undefined;
  hold(phase: "create" | "restore" | "send" | "control") {
    this.heldPhase = phase;
    this.phaseGate = new Promise<void>((resolve) => {
      this.phaseReleased = resolve;
    });
    return new Promise<void>((resolve) => {
      this.phaseStarted = resolve;
    });
  }
  release() {
    this.phaseReleased();
  }
  private readonly pendingControls = new Set<string>();
  async inspectOperation(key: string) {
    return {
      agentId: null,
      outcome: this.pendingControls.has(key) ? ("pending" as const) : ("settled" as const),
    };
  }
  async cancelOperation(key: string, creationKey: string) {
    return {
      agentId: this.creationKeys.get(creationKey)?.id ?? null,
      outcome: this.pendingStartup === key ? ("pending" as const) : ("settled" as const),
    };
  }
  private async pause(
    phase: "create" | "restore" | "send" | "control",
    startup?: { key: string; signal?: AbortSignal },
  ) {
    if (this.heldPhase !== phase) return;
    this.heldPhase = undefined;
    this.pendingStartup = startup?.key;
    this.phaseStarted();
    const operation = this.phaseGate!.then(() => {
      this.pendingStartup = undefined;
      return;
    });
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          abort = () => reject(startup?.signal?.reason);
          startup?.signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
      startup?.signal?.throwIfAborted();
    } finally {
      if (abort) startup?.signal?.removeEventListener("abort", abort);
    }
  }
  readonly agents = new Map<string, AgentSnapshot>();
  readonly deliveries: { agentId: string; text: string }[] = [];
  readonly creates: DaemonCreateAgentOptions[] = [];
  readonly messages = new Set<string>();
  archives = 0;
  restorations = 0;
  async create(key: string, options: DaemonCreateAgentOptions, startup?: AgentStartup) {
    let agent = this.creationKeys.get(key);
    if (!agent) {
      this.creates.push(options);
      agent = { id: randomUUID(), workspaceId: randomUUID(), status: "idle" };
      this.creationKeys.set(key, agent);
      this.agents.set(agent.id, agent);
    }
    await this.pause("create", startup);
    return agent;
  }
  async get(id: string) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error("missing");
    return agent;
  }
  async send(agentId: string, messageId: string, text: string, startup?: AgentStartup) {
    await this.pause("send", startup);
    if (this.messages.has(messageId)) return;
    this.messages.add(messageId);
    this.deliveries.push({ agentId, text });
  }
  async watch() {
    return () => {};
  }
  async restore(workspaceId: string, startup?: AgentStartup) {
    await this.pause("restore", startup);
    this.restorations++;
    for (const [id, agent] of this.agents)
      if (agent.workspaceId === workspaceId) this.agents.set(id, { ...agent, archivedAt: null });
    return true;
  }
  async control(
    agentId: string,
    _workspaceId: string,
    action: "interrupt" | "archive",
    operationKey?: string,
    signal?: AbortSignal,
  ) {
    if (operationKey) this.pendingControls.add(operationKey);
    const operation = (async () => {
      await this.pause("control", operationKey ? { key: operationKey } : undefined);
      if (action === "archive") {
        this.archives++;
        this.agents.set(agentId, {
          ...(await this.get(agentId)),
          archivedAt: new Date().toISOString(),
        });
      }
    })().finally(() => {
      if (operationKey) this.pendingControls.delete(operationKey);
    });
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
}

async function fixture() {
  const database = createMemoryDatabase();
  const connection = new TestAgents();
  const outputs = new OutputExecutorRegistry();
  const replies: { executionId: string; context: unknown }[] = [];
  outputs.register({
    type: "test.reply",
    tool: replyOutputTool,
    execute: async (input) => {
      replies.push({ executionId: input.agentExecutionId, context: input.outputContext });
    },
  });
  const sessions = new AgentSessions(database, "secret", "https://hub.test", outputs);
  const capabilities = createExecutionCapabilityServer({
    database,
    outputs,
    completionTokenSecret: "secret",
    completeExecution: async ({ executionId }) =>
      (await database.transitionAgentExecution(executionId, "succeeded")).execution,
  });
  async function arrival(
    key: string | null = "conversation",
    target = "daemon",
    env: Record<string, string> = {},
  ) {
    const executionId = randomUUID();
    const intent: LaunchMachineIntent = {
      kind: "launch_machine",
      organizationId: "org",
      projectId: "project",
      triggerRunId: randomUUID(),
      triggerName: "answer",
      environmentName: "target",
      environment: { kind: "daemon", daemonId: target, authoredSlug: target, cwd: "/repo" },
      agent: { provider: "codex" },
      prompt: "hello",
      env,
      allowOutputs: [{ type: "test.reply", max: 1 }],
      autoArchive: true,
      triggerContext: {},
      outputContext: { arrival: executionId },
      configurationRevisionId: randomUUID(),
      hubConfig: {},
      continuation: { key, compatibility: { target } },
    };
    await database.insertAgentExecution({
      id: executionId,
      organizationId: "org",
      projectId: "project",
      machineId: null,
      triggerContext: {},
      outputContext: intent.outputContext,
      configurationRevisionId: intent.configurationRevisionId,
      launchIntent: intent,
    });
    const controller = new AbortController();
    return {
      executionId,
      cancel: () => controller.abort(new Error("startup expired")),
      dispatch: () =>
        sessions.dispatch({
          executionId,
          intent,
          startup: {
            key: executionId,
            deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            signal: controller.signal,
          },
          connection,
          onEvent: () => {},
          createOptions: async () => ({
            executionId,
            provider: "codex",
            cwd: "/repo",
            prompt: "hello",
            env: {},
            toolPolicy: { preapproved: [] },
          }),
        }),
    };
  }
  async function execution(id: string) {
    const item = await database.findAgentExecutionById(id);
    if (!item) throw new Error("missing execution");
    return item;
  }
  async function call(
    executionId: string,
    name: string,
    args: Record<string, unknown>,
    ownerId = executionId,
  ) {
    const owner = await execution(ownerId);
    const session = await database.findAgentSession(owner.agentSessionId!);
    const mcp = session!.creationOptions.mcpServers!["hub"]!;
    const response = await capabilities.handleSession(
      new Request(mcp.url, {
        method: "POST",
        headers: {
          ...mcp.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { ...args, executionId } },
        }),
      }),
      session!.id,
    );
    const result: unknown = await response.json();
    return result;
  }
  return { database, connection, sessions, replies, arrival, execution, call };
}

test("same-key arrivals share an agent; an earlier completion cannot archive newer work", async () => {
  const f = await fixture();
  const first = await f.arrival();
  const second = await f.arrival();
  const [a, b] = await Promise.all([first.dispatch(), second.dispatch()]);
  expect(a.agentId).toBe(b.agentId);
  expect(f.connection.creates).toHaveLength(1);
  expect(f.connection.deliveries).toHaveLength(2);
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  await f.sessions.control(await f.execution(first.executionId), f.connection, "archive");
  expect(f.connection.archives).toBe(0);
  await f.database.transitionAgentExecution(second.executionId, "succeeded");
  await f.sessions.control(await f.execution(second.executionId), f.connection, "archive");
  expect(f.connection.archives).toBe(1);
  const third = await f.arrival();
  expect(await third.dispatch()).toMatchObject({ agentId: a.agentId, action: "restored" });
  expect(f.connection.restorations).toBe(1);
});

test("session tools keep each arrival's destination and reject stale or foreign execution IDs", async () => {
  const f = await fixture();
  const first = await f.arrival();
  const second = await f.arrival();
  await first.dispatch();
  await second.dispatch();
  expect(await f.call(first.executionId, "reply", { content: "first" })).toMatchObject({
    result: { content: [{ type: "text", text: "Output sent" }] },
  });
  expect(await f.call(first.executionId, "finish_execution", {})).toMatchObject({
    result: { content: [{ type: "text", text: "Execution finished" }] },
  });
  expect(await f.call(first.executionId, "reply", { content: "stale" })).toMatchObject({
    result: { isError: true },
  });
  expect(await f.call(second.executionId, "reply", { content: "second" })).toMatchObject({
    result: { content: [{ type: "text", text: "Output sent" }] },
  });
  expect(f.replies).toEqual([
    { executionId: first.executionId, context: { arrival: first.executionId } },
    { executionId: second.executionId, context: { arrival: second.executionId } },
  ]);
  const foreign = await f.arrival("another");
  await foreign.dispatch();
  expect(
    await f.call(foreign.executionId, "finish_execution", {}, second.executionId),
  ).toMatchObject({ result: { isError: true } });
});

test("new-agent policy isolates arrivals and incompatible targets fail without replacement", async () => {
  const f = await fixture();
  const a = await f.arrival(null);
  const b = await f.arrival(null);
  expect((await a.dispatch()).agentId).not.toBe((await b.dispatch()).agentId);
  const first = await f.arrival();
  await first.dispatch();
  const changed = await f.arrival("conversation", "different-daemon");
  await expect(changed.dispatch()).rejects.toThrow("Continuation settings differ");
  expect(f.connection.creates).toHaveLength(3);
});

test("temporary environment credentials require a new agent instead of being reused", async () => {
  const f = await fixture();
  const env = { TOKEN: "${{ paseo.connections.support.token }}" };
  const continuing = await f.arrival("conversation", "daemon", env);
  await expect(continuing.dispatch()).rejects.toThrow(
    "Temporary environment credentials require New agent",
  );
  expect(f.connection.creates).toHaveLength(0);
  const fresh = await f.arrival(null, "daemon", env);
  await fresh.dispatch();
  expect(f.connection.creates).toHaveLength(1);
});

test.each(["create", "restore", "send"] as const)(
  "expiry during %s releases conversation ownership and accounts for late work",
  async (phase) => {
    const f = await fixture();
    if (phase === "restore") {
      const initial = await f.arrival();
      await initial.dispatch();
      await f.database.transitionAgentExecution(initial.executionId, "succeeded");
      await f.sessions.control(await f.execution(initial.executionId), f.connection, "archive");
    }
    const entered = f.connection.hold(phase);
    const first = await f.arrival();
    const dispatch = first.dispatch();
    const rejected = expect(dispatch).rejects.toThrow("startup expired");
    await entered;
    await f.database.transitionAgentExecution(first.executionId, "failed", {
      hubAction: "archive",
    });
    first.cancel();
    await rejected;
    await expect(
      f.sessions.control(await f.execution(first.executionId), f.connection, "archive"),
    ).rejects.toThrow("cancellation is pending");

    const competing = await f.arrival();
    await expect(competing.dispatch()).rejects.toThrow("cancellation is pending");
    await f.database.transitionAgentExecution(competing.executionId, "failed", {
      hubAction: "archive",
    });
    f.connection.release();
    await expect
      .poll(async () => {
        try {
          await f.sessions.control(await f.execution(first.executionId), f.connection, "archive");
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    await f.database.completeHubAction(first.executionId, "archive");
    await f.sessions.control(await f.execution(competing.executionId), f.connection, "archive");
    await f.database.completeHubAction(competing.executionId, "archive");
    expect((await f.execution(first.executionId)).daemonAgentId).toBe(
      phase === "send" ? [...f.connection.agents.keys()][0] : null,
    );
    const next = await f.arrival();
    await next.dispatch();
    expect(f.connection.creates).toHaveLength(1);
    expect(f.connection.deliveries).toHaveLength(phase === "restore" ? 2 : 1);
  },
);

test("a slow archive remains owned after its acknowledgement wait expires", async () => {
  const f = await fixture();
  const first = await f.arrival();
  await first.dispatch();
  await f.database.transitionAgentExecution(first.executionId, "succeeded", {
    hubAction: "archive",
  });
  const entered = f.connection.hold("control");
  const controller = new AbortController();
  const cleanup = f.sessions.control(
    await f.execution(first.executionId),
    f.connection,
    "archive",
    controller.signal,
  );
  const rejected = expect(cleanup).rejects.toThrow("control wait expired");
  await entered;
  controller.abort(new Error("control wait expired"));
  await rejected;
  const next = await f.arrival();
  await expect(next.dispatch()).rejects.toThrow("cleanup is pending");
  await f.database.transitionAgentExecution(next.executionId, "failed", { hubAction: "archive" });
  f.connection.release();
  await expect.poll(() => f.connection.archives).toBe(1);
  await f.database.completeHubAction(first.executionId, "archive");
  await f.sessions.control(await f.execution(next.executionId), f.connection, "archive");
  await f.database.completeHubAction(next.executionId, "archive");
  const subsequent = await f.arrival();
  await subsequent.dispatch();
  expect(f.connection.creates).toHaveLength(1);
  expect(f.connection.restorations).toBe(1);
});

test("a continuation cannot overtake a durable cleanup action that has not been acknowledged", async () => {
  const f = await fixture();
  const first = await f.arrival();
  await first.dispatch();
  await f.database.transitionAgentExecution(first.executionId, "succeeded", {
    hubAction: "archive",
  });
  const next = await f.arrival();
  await expect(next.dispatch()).rejects.toThrow("cleanup is pending");
  expect(f.connection.deliveries).toHaveLength(1);
});
