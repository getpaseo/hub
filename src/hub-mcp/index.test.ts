import assert from "node:assert/strict";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { describe, it, vi } from "vitest";
import { createHubMcp } from "./index.js";
import type { ApiKeyScope } from "../auth/api-key-contract.js";
import type { DaemonRecord } from "../db/types.js";
import { DaemonAgents } from "../daemons/agents/index.js";
import { DaemonResponseLostError } from "../daemons/protocol.js";
import { createFetchServer } from "../http/node-server.js";
import { takeResponseLifecycle } from "../http/response-lifecycle.js";
import { createPublicApi } from "../public-api/index.js";

const RpcResultSchema = z.object({
  result: z.object({
    tools: z
      .array(z.object({ name: z.string(), inputSchema: z.record(z.string(), z.unknown()) }))
      .optional(),
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })).optional(),
  }),
});
const pageInfo = { nextCursor: null, prevCursor: null, hasMore: false };
const agent = {
  id: "agent",
  workspaceId: "workspace",
  status: "running",
  provider: "codex",
  cwd: "/repo",
  currentModeId: "full-access",
  pendingPermissions: [],
  persistence: { secret: "private-provider-handle" },
  runtimeInfo: { secret: "private-runtime-token" },
};
const daemon: DaemonRecord = {
  id: "daemon",
  slug: "dev-machine",
  machineId: "machine",
  serverId: "server",
  daemonPublicKey: "private-key",
  credentialVerifier: "private-verifier",
  permissions: ["hub.execute"],
  registeredByApiKeyId: null,
  registeredByCliCredentialId: null,
  status: "active",
  presence: "connected",
  connectedAt: new Date(0),
  disconnectedAt: null,
  lastSeenAt: new Date(0),
  createdAt: new Date(0),
};
const creation = {
  daemonId: daemon.id,
  requestKey: "task-1",
  cwd: "/repo",
  provider: "codex",
  model: "chosen-model",
  thinkingOptionId: "high",
  modeId: "full-access",
  providerOptions: { sandbox_mode: "danger-full-access" },
  prompt: "Implement the requested change.",
};

function fixture(
  scopes: readonly ApiKeyScope[] = [
    "agents:read",
    "agents:control",
    "projects:read",
    "runs:dispatch",
  ],
) {
  const requests: Record<string, unknown>[] = [];
  let revoked = false;
  let connected = true;
  const agents = new DaemonAgents((frame) => {
    const { message } = z
      .object({ message: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(frame));
    requests.push(message);
    const type = message["type"];
    const payload: Record<string, unknown> = {
      requestId: message["requestId"],
      accepted: true,
      error: null,
    };
    if (type === "create_agent_request") Object.assign(payload, { status: "agent_created", agent });
    if (type === "fetch_agent_request") Object.assign(payload, { agent });
    if (type === "fetch_agents_request") Object.assign(payload, { entries: [{ agent }], pageInfo });
    if (type === "fetch_workspaces_request")
      Object.assign(payload, {
        entries: [
          {
            id: "workspace",
            name: "main",
            projectId: "project",
            projectDisplayName: "repo",
            projectRootPath: "/repo",
            workspaceDirectory: "/repo",
            workspaceKind: "local_checkout",
          },
        ],
        emptyProjects: [
          {
            projectId: "empty-project",
            projectDisplayName: "empty",
            projectRootPath: "/empty-repo",
          },
        ],
        pageInfo,
      });
    if (type === "fetch_agent_timeline_request")
      Object.assign(payload, {
        agentId: "agent",
        agent,
        direction: message["direction"],
        epoch: "epoch-1",
        reset: false,
        staleCursor: false,
        gap: false,
        startCursor: { epoch: "epoch-1", seq: 1 },
        endCursor: { epoch: "epoch-1", seq: 2 },
        hasOlder: false,
        hasNewer: false,
        entries: [
          {
            provider: "codex",
            timestamp: "2026-10-10T00:00:00Z",
            seqStart: 1,
            seqEnd: 2,
            item: { type: "assistant_message", text: "Worker result" },
          },
        ],
      });
    agents.receive({
      type: "session",
      message: { type: type === "create_agent_request" ? "status" : "response", payload },
    });
  });
  agents.receive({
    type: "session",
    message: {
      type: "status",
      payload: {
        status: "server_info",
        features: { hubAgentRpc: true, agentRequestReceipts: true },
      },
    },
  });
  const providers = {
    requestId: "provider-request",
    generatedAt: "2026-10-10T00:00:00Z",
    entries: [
      {
        provider: "codex",
        status: "ready" as const,
        enabled: true,
        models: [
          {
            provider: "codex",
            id: "chosen-model",
            label: "Chosen",
            thinkingOptions: [{ id: "high", label: "High" }],
          },
        ],
        modes: [{ id: "full-access", label: "Full access" }],
      },
    ],
  };
  const findDaemon = vi.fn(async (organizationId: string, daemonId: string) =>
    organizationId === "org-a" && daemonId === daemon.id ? daemon : undefined,
  );
  const dispatch = vi.fn(async () => ({
    status: "dispatched" as const,
    deliveryKey: "delivery",
    providerEventReceiptId: "receipt",
    triggerRunId: "run",
    configuredTriggerName: "manual",
    workflowStatus: "running" as const,
  }));
  const mcp = createHubMcp({
    composition: {
      status: "enabled",
      authenticator: {
        async authorize(request, scope) {
          if (revoked || request.headers.get("authorization") !== "Bearer api-key")
            return { status: "unauthorized" };
          if (!scopes.includes(scope)) return { status: "forbidden" };
          return {
            status: "authorized",
            access: { kind: "apiKey", credentialId: "credential", organizationId: "org-a", scopes },
          };
        },
      },
    },
    database: {
      findDaemonForOrganization: findDaemon,
      listDaemonsForOrganization: async () => [
        daemon,
        { ...daemon, id: "no-execute", permissions: [] },
        { ...daemon, id: "revoked", status: "revoked" },
      ],
    },
    connectionForDaemon: () =>
      connected
        ? {
            agents,
            agentControl: agents,
            getProviderSnapshot: async () => providers,
            refreshProviderSnapshot: async () => {},
            validateAgentConfiguration: async () => ({ valid: true }),
          }
        : undefined,
    operations: {
      listProjects: async () => ({
        status: "listed",
        projects: [{ id: "project", name: "Project", slug: "project" }],
      }),
      dispatchManualRun: dispatch,
    },
  });
  async function rpc(method: string, params: unknown = {}, token = "api-key", origin?: string) {
    const response = await mcp.handle(
      new Request("https://hub.test/api/v1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          ...(origin === undefined ? {} : { origin }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    try {
      return {
        status: response.status,
        body: z.unknown().parse(await response.json()),
        headers: response.headers,
      };
    } finally {
      await takeResponseLifecycle(response)?.onFinish();
    }
  }
  async function call(name: string, args: unknown = {}) {
    return RpcResultSchema.parse((await rpc("tools/call", { name, arguments: args })).body).result;
  }
  return {
    mcp,
    agents,
    requests,
    rpc,
    call,
    findDaemon,
    dispatch,
    revoke: () => {
      revoked = true;
    },
    disconnect: () => {
      connected = false;
    },
  };
}
function textResult(result: { content?: { text: string }[] | undefined }) {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(result.content?.[0]?.text ?? "{}"));
}

describe("Hub organization MCP", () => {
  it("authenticates every HTTP request and rejects execution tokens and revoked keys", async () => {
    const f = fixture();
    assert.equal((await f.rpc("tools/list", {}, "execution-token")).status, 401);
    assert.equal((await f.rpc("tools/list")).status, 200);
    f.revoke();
    const revoked = await f.rpc("tools/list");
    assert.equal(revoked.status, 401);
    assert.equal(revoked.headers.get("www-authenticate"), "Bearer");
    assert.equal(revoked.headers.get("cache-control"), "no-store");
  });
  it("filters discovery and rejects guessed write tools for read-only keys", async () => {
    const f = fixture(["agents:read"]);
    const tools = RpcResultSchema.parse((await f.rpc("tools/list")).body).result.tools;
    assert.deepEqual(
      tools?.map((t) => t.name),
      [
        "list_daemons",
        "get_providers",
        "list_workspaces",
        "list_agents",
        "get_agent",
        "get_agent_activity",
      ],
    );
    assert.equal((await f.call("create_agent", creation)).isError, true);
    assert.equal(f.requests.length, 0);
  });
  it("rejects cross-origin browser requests and unrelated scopes", async () => {
    assert.equal(
      (await fixture().rpc("tools/list", {}, "api-key", "https://attacker.test")).status,
      403,
    );
    assert.equal((await fixture(["daemons:enroll"]).rpc("tools/list")).status, 403);
  });
  it("keeps defaulted creation arguments optional in the published input schema", async () => {
    const tools = RpcResultSchema.parse((await fixture().rpc("tools/list")).body).result.tools;
    const required = tools?.find((t) => t.name === "create_agent")?.inputSchema["required"];
    assert(!z.array(z.string()).parse(required).includes("workspace"));
  });
  it("discovers eligible daemons and provider-native settings without credential material", async () => {
    const f = fixture();
    const daemons = textResult(await f.call("list_daemons"));
    assert.deepEqual(daemons, {
      daemons: [{ id: "daemon", slug: "dev-machine", connected: true }],
    });
    assert(!JSON.stringify(daemons).includes("private"));
    assert.match(
      JSON.stringify(textResult(await f.call("get_providers", { daemonId: daemon.id }))),
      /chosen-model/u,
    );
  });
  it("checks organization ownership and connection before agent RPC", async () => {
    const f = fixture();
    assert.equal(
      textResult(await f.call("get_agent", { daemonId: "other-org-daemon", agentId: "agent" }))[
        "error"
      ],
      "daemon_unavailable",
    );
    assert.equal(f.requests.length, 0);
    f.findDaemon.mockResolvedValueOnce({ ...daemon, permissions: [] });
    assert.equal(
      textResult(await f.call("get_agent", { daemonId: daemon.id, agentId: "agent" }))["error"],
      "daemon_execution_not_allowed",
    );
    assert.equal(f.requests.length, 0);
    f.disconnect();
    assert.equal(
      textResult(await f.call("get_agent", { daemonId: daemon.id, agentId: "agent" }))["error"],
      "daemon_not_connected",
    );
    assert.equal(f.requests.length, 0);
  });
  it("starts parallel agents with isolated worktrees, stable receipts and unchanged provider configuration", async () => {
    const f = fixture();
    const results = await Promise.all([
      f.call("create_agent", creation),
      f.call("create_agent", { ...creation, requestKey: "task-2" }),
    ]);
    assert(results.every((r) => !r.isError));
    assert.equal(f.requests.length, 4);
    assert.notEqual(f.requests[0]?.["idempotencyKey"], f.requests[1]?.["idempotencyKey"]);
    assert.deepEqual(f.requests[0]?.["config"], {
      cwd: "/repo",
      provider: "codex",
      modeId: "full-access",
      model: "chosen-model",
      thinkingOptionId: "high",
      providerOptions: { sandbox_mode: "danger-full-access" },
      toolPolicy: { preapproved: [] },
    });
    assert(!("initialPrompt" in f.requests[0]));
    assert.equal(f.requests[2]?.["text"], creation.prompt);
    assert.match(
      z.object({ newBranch: z.string() }).parse(f.requests[0]?.["worktree"]).newBranch,
      /^hub\/mcp-/u,
    );
    await f.call("create_agent", creation);
    assert.equal(f.requests[0]?.["idempotencyKey"], f.requests[4]?.["idempotencyKey"]);
    assert.equal(f.requests[2]?.["messageId"], f.requests[5]?.["messageId"]);
    assert.deepEqual(textResult(results[0]), {
      daemonId: "daemon",
      agentId: "agent",
      workspaceId: "workspace",
      promptAccepted: true,
    });
  });
  it("requires explicit provider permission mode and supports explicit workspace reuse", async () => {
    const f = fixture();
    const { modeId: _modeId, ...withoutMode } = creation;
    assert.equal((await f.call("create_agent", withoutMode)).isError, true);
    assert.equal(f.requests.length, 0);
    await f.call("create_agent", {
      ...creation,
      workspace: { kind: "reuse", workspaceId: "existing-workspace" },
    });
    assert.equal(f.requests[0]?.["workspaceId"], "existing-workspace");
    assert(!("worktree" in f.requests[0]));
  });
  it("returns actionable retry information for a lost durable creation acknowledgement", async () => {
    const f = fixture();
    vi.spyOn(f.agents, "create").mockRejectedValueOnce(new DaemonResponseLostError());
    const result = await f.call("create_agent", creation);
    assert.equal(result.isError, true);
    assert.equal(textResult(result)["error"], "daemon_response_lost");
    assert.match(z.string().parse(textResult(result)["message"]), /same requestKey/u);
  });
  it("lists workspace repository roots and agent snapshots without provider persistence", async () => {
    const f = fixture();
    const workspaceResult = await f.call("list_workspaces", {
      daemonId: daemon.id,
      cursor: "next-page",
      limit: 10,
    });
    assert.match(JSON.stringify(textResult(workspaceResult)), /\/empty-repo/u);
    assert.deepEqual(f.requests[0]?.["page"], { cursor: "next-page", limit: 10 });
    const listed = await f.call("list_agents", { daemonId: daemon.id });
    assert(!JSON.stringify(textResult(listed)).includes("private"));
    const details = await f.call("get_agent", { daemonId: daemon.id, agentId: "agent" });
    assert.equal(textResult(details)["status"], "running");
    assert(!JSON.stringify(textResult(details)).includes("private"));
  });
  it("reads persisted activity with bounded cursor pagination after a new MCP request", async () => {
    const f = fixture();
    const result = await f.call("get_agent_activity", {
      daemonId: daemon.id,
      agentId: "agent",
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
    });
    assert.match(JSON.stringify(textResult(result)), /Worker result/u);
    assert.deepEqual(f.requests[0]?.["cursor"], { epoch: "epoch-1", seq: 1 });
    assert.equal(f.requests[0]?.["limit"], 50);
    assert.equal(
      (await f.call("get_agent_activity", { daemonId: daemon.id, agentId: "agent", limit: 0 }))
        .isError,
      true,
    );
  });
  it("keeps message receipt identity stable and passes busy-agent behavior", async () => {
    const f = fixture();
    const args = {
      daemonId: daemon.id,
      agentId: "agent",
      messageKey: "message-1",
      text: "Continue",
    };
    await f.call("send_agent_message", args);
    await f.call("send_agent_message", args);
    assert.equal(f.requests[0]?.["messageId"], f.requests[1]?.["messageId"]);
    assert.equal(f.requests[0]?.["activeTurnBehavior"], "steer");
    await f.call("send_agent_message", {
      ...args,
      messageKey: "message-2",
      activeTurnBehavior: "interrupt",
    });
    assert.equal(f.requests[2]?.["activeTurnBehavior"], "interrupt");
  });
  it("keeps turn interruption, agent archive, and workspace cleanup distinct", async () => {
    const f = fixture();
    await f.call("interrupt_agent", { daemonId: daemon.id, agentId: "agent" });
    await f.call("archive_agent", { daemonId: daemon.id, agentId: "agent" });
    await f.call("archive_workspace", { daemonId: daemon.id, workspaceId: "workspace" });
    assert.deepEqual(
      f.requests.map((r) => r["type"]),
      [
        "fetch_agent_request",
        "cancel_agent_request",
        "archive_agent_request",
        "archive_workspace_request",
      ],
    );
  });
  it("dispatches an existing workflow through the shared public operations", async () => {
    const f = fixture(["runs:dispatch"]);
    await f.call("dispatch_manual_run", {
      projectSlug: "project",
      trigger: "manual",
      actor: "operator",
      deliveryKey: "delivery",
      input: { task: "Work" },
    });
    assert.equal(f.dispatch.mock.calls.length, 1);
  });
  it("serves the canonical MCP path through the public API router", async () => {
    const f = fixture();
    const api = createPublicApi({ status: "unavailable" }, null, f.mcp);
    const response = await api.handle(
      new Request("https://hub.test/api/v1/mcp", { method: "POST" }),
    );
    assert.equal(response.status, 401);
  });
  it("interoperates with the official MCP HTTP client across reconnects", async () => {
    const f = fixture();
    const server = createFetchServer((request) => f.mcp.handle(request));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const url = new URL(`http://127.0.0.1:${address.port}/api/v1/mcp`);
    async function connectClient() {
      const client = new Client({ name: "generic-harness", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: "Bearer api-key" } },
      });
      // @ts-expect-error upstream SDK exactOptionalPropertyTypes mismatch
      await client.connect(transport);
      return client;
    }
    try {
      const first = await connectClient();
      try {
        assert.equal((await first.listTools()).tools.length, 13);
        assert.equal(
          (await first.callTool({ name: "create_agent", arguments: creation })).isError,
          undefined,
        );
      } finally {
        await first.close();
      }
      const second = await connectClient();
      try {
        const result = await second.callTool({
          name: "get_agent_activity",
          arguments: { daemonId: daemon.id, agentId: "agent" },
        });
        assert.match(JSON.stringify(result), /Worker result/u);
      } finally {
        await second.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });
});
