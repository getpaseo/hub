import { z } from "zod";
import { expect, test, vi } from "vitest";
import { DaemonAgents } from "./index.js";
import { DaemonResponseLostError, type DaemonCreateAgentOptions } from "../protocol.js";

const prompt = "Full request context. ".repeat(1_000) + "End.";
const options: DaemonCreateAgentOptions = {
  provider: "codex",
  cwd: "/workspace",
  env: { REQUEST_ENV: "configured" },
  providerOptions: { sandbox_mode: "workspace-write" },
  toolPolicy: { preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }] },
};

test("ordinary creation keeps prompt delivery separate from optional titles and preserves provider configuration", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = new DaemonAgents((frame) => {
    const { message } = z
      .object({ message: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(frame));
    requests.push(message);
    agents.receive({
      type: "session",
      message: {
        type: message["type"] === "create_agent_request" ? "status" : "send_agent_message_response",
        payload: {
          requestId: message["requestId"],
          status: "agent_created",
          accepted: true,
          agent: { id: "agent", workspaceId: "workspace", status: "idle" },
        },
      },
    });
  });
  enable(agents);
  const created = await agents.create("stable-creation-key", options);
  await agents.send(created.id, "stable-message-key", prompt);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    type: "create_agent_request",
    idempotencyKey: "stable-creation-key",
    config: {
      provider: options.provider,
      cwd: options.cwd,
      providerOptions: options.providerOptions,
      toolPolicy: options.toolPolicy,
    },
    env: options.env,
  });
  expect(requests[0]).not.toHaveProperty("initialPrompt");
  expect(requests[0]).not.toHaveProperty("config.title");
  expect(requests[1]).toMatchObject({
    type: "send_agent_message_request",
    agentId: created.id,
    messageId: "stable-message-key",
    text: prompt,
  });
});

test("requires ordinary agent RPCs and durable receipts instead of falling back to Hub creation", async () => {
  const frames: string[] = [];
  const agents = new DaemonAgents((frame) => frames.push(frame));
  await expect(agents.create("key", options)).rejects.toThrow("Update the Paseo daemon");
  expect(frames).toEqual([]);
});

test("a lost response remains recoverable instead of reporting a rejected creation", async () => {
  const agents = new DaemonAgents(() => {});
  enable(agents);
  const creation = agents.create("key", options);
  agents.close();
  await expect(creation).rejects.toBeInstanceOf(DaemonResponseLostError);
});

function enable(agents: DaemonAgents): void {
  agents.receive({
    type: "session",
    message: {
      type: "server_info",
      payload: { features: { hubAgentRpc: true, agentRequestReceipts: true } },
    },
  });
}

test.each(["create", "restore", "send"] as const)(
  "%s honors the supplied startup wait without changing the RPC",
  async (operation) => {
    vi.useFakeTimers();
    let respond: (() => void) | undefined;
    const agents = new DaemonAgents((frame) => {
      const { message } = z
        .object({ message: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(frame));
      const reply = () =>
        agents.receive({
          type: "session",
          message: {
            type: "response",
            payload: {
              requestId: message["requestId"],
              state: { kind: "recoverable" },
              accepted: true,
              agent: { id: "agent", workspaceId: "workspace", status: "idle" },
            },
          },
        });
      if (message["type"] === "workspace.recovery.inspect.request") reply();
      else respond = reply;
      expect(message).not.toHaveProperty("timeoutMs");
    });
    try {
      enable(agents);
      const start = () => {
        if (operation === "create") return agents.create("key", options, 180_000);
        if (operation === "restore") return agents.restore("workspace", 180_000);
        return agents.send("agent", "message-key", "hello", 180_000);
      };
      const outcome = start().then(
        () => "accepted",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(150_000);
      expect(respond).toBeDefined();
      respond!();
      expect(await outcome).toBe("accepted");

      const expired = start().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(await expired).toBeInstanceOf(DaemonResponseLostError);
    } finally {
      agents.close();
      vi.useRealTimers();
    }
  },
);
