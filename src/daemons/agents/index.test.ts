import { z } from "zod";
import { afterEach, expect, test, vi } from "vitest";
import { DaemonAgents } from "./index.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  const frames: { type: string; requestId: string; operation?: unknown }[] = [];
  const agents = new DaemonAgents((frame) => {
    frames.push(
      z
        .object({
          message: z.object({
            type: z.string(),
            requestId: z.string(),
            operation: z.unknown().optional(),
          }),
        })
        .parse(JSON.parse(frame)).message,
    );
  });
  agents.receive({
    type: "session",
    message: {
      type: "server_info",
      payload: {
        features: { hubAgentRpc: true, agentRequestReceipts: true, agentRequestCancellation: true },
      },
    },
  });
  const controller = new AbortController();
  const startup = {
    key: "execution",
    deadlineAt: new Date(Date.now() + 300_000).toISOString(),
    signal: controller.signal,
  };
  function reply(payload: Record<string, unknown> = {}) {
    return agents.receive({
      type: "session",
      message: { type: "response", payload: { requestId: frames.at(-1)!.requestId, ...payload } },
    });
  }
  async function begin(phase: "create" | "restore" | "send") {
    let result: Promise<unknown>;
    if (phase === "create")
      result = agents.create(
        "conversation",
        {
          executionId: "execution",
          provider: "codex",
          cwd: "/repo",
          prompt: "hello",
          env: {},
          toolPolicy: { preapproved: [] },
        },
        startup,
      );
    else if (phase === "restore") result = agents.restore("workspace", startup);
    else result = agents.send("agent", "message", "hello", startup);
    if (phase === "restore") {
      reply({ state: { kind: "recoverable" } });
      await Promise.resolve();
      await Promise.resolve();
    }
    return { result };
  }
  return { agents, frames, controller, startup, reply, begin };
}

test.each(["create", "restore", "send"] as const)(
  "%s can acknowledge after thirty seconds under the execution deadline",
  async (phase) => {
    vi.useFakeTimers();
    const f = fixture();
    const { result } = await f.begin(phase);
    let settled = false;
    void result.then(() => {
      settled = true;
      return;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    expect(f.frames.at(-1)?.operation).toEqual({
      key: f.startup.key,
      deadlineAt: f.startup.deadlineAt,
    });
    f.reply({ agent: { id: "agent", workspaceId: "workspace", status: "idle" } });
    await result;
    f.agents.close();
  },
);

test.each(["create", "restore", "send"] as const)(
  "%s abort settles its waiter and ignores a late acknowledgement",
  async (phase) => {
    const f = fixture();
    const { result } = await f.begin(phase);
    const failed = expect(result).rejects.toThrow("execution expired");
    f.controller.abort(new Error("execution expired"));
    await failed;
    expect(f.reply({ agent: { id: "late", workspaceId: "workspace", status: "idle" } })).toBe(
      false,
    );
    f.agents.close();
  },
);

test("read requests retain a bounded acknowledgement wait", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const failed = expect(f.agents.get("agent")).rejects.toThrow("Daemon request timed out");
  await vi.advanceTimersByTimeAsync(30_000);
  await failed;
  expect(f.reply({ agent: { id: "late", workspaceId: "workspace", status: "idle" } })).toBe(false);
});
