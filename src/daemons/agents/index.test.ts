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

function connect(
  requests: Record<string, unknown>[],
  titleResponse: (requestId: unknown) => Record<string, unknown> = (requestId) => ({
    type: "workspace.title.set.response",
    payload: { requestId, workspaceId: "workspace", accepted: true, title: "x", error: null },
  }),
  reportFailure?: (error: unknown, operation: string) => void,
): DaemonAgents {
  const agents = new DaemonAgents(
    (frame) => {
      const { message } = z
        .object({ message: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(frame));
      requests.push(message);
      const requestId = message["requestId"];
      if (message["type"] === "workspace.title.set.request") {
        agents.receive({ type: "session", message: titleResponse(requestId) });
        return;
      }
      agents.receive({
        type: "session",
        message: {
          type:
            message["type"] === "create_agent_request" ? "status" : "send_agent_message_response",
          payload: {
            requestId,
            status: "agent_created",
            accepted: true,
            agent: { id: "agent", workspaceId: "workspace", status: "idle" },
          },
        },
      });
    },
    undefined,
    reportFailure,
  );
  enable(agents);
  return agents;
}

test("ordinary creation keeps prompt delivery separate from creation and preserves provider configuration", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connect(requests);
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

test("a titled creation names the agent and then the workspace the daemon created for it", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connect(requests);
  const created = await agents.create("key", {
    ...options,
    title: "Hub agent",
    workspaceTitle: "Hub · pr-triage · e6a296d1",
  });
  expect(created.workspaceId).toBe("workspace");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    type: "create_agent_request",
    config: { title: "Hub agent" },
  });
  expect(requests[1]).toMatchObject({
    type: "workspace.title.set.request",
    workspaceId: "workspace",
    title: "Hub · pr-triage · e6a296d1",
  });
});

test("a rejected workspace title is reported and leaves the titled agent usable", async () => {
  const requests: Record<string, unknown>[] = [];
  const failures: string[] = [];
  const agents = connect(
    requests,
    (requestId) => ({
      type: "rpc_error",
      payload: { requestId, error: "Workspace not found" },
    }),
    (error, operation) => failures.push(`${operation}: ${String(error)}`),
  );
  const created = await agents.create("key", {
    ...options,
    title: "Hub agent",
    workspaceTitle: "Hub · pr-triage · e6a296d1",
  });
  expect(created.id).toBe("agent");
  expect(requests.map((request) => request["type"])).toEqual([
    "create_agent_request",
    "workspace.title.set.request",
  ]);
  expect(failures).toEqual(["daemon.workspace.title.set: Error: Workspace not found"]);
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
