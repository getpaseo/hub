import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, it } from "vitest";
import { z } from "zod";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { createDatabase } from "../db/pg.js";
import { createAuthServer } from "../auth/server.js";
import { composeEntitlements } from "../auth/entitlements.js";
import { createApplicationRuntime } from "../application-runtime.js";
import { createFetchServer } from "../http/node-server.js";
import { loadBuiltStartServer } from "../server/build.js";
import { SourcePaseo } from "./harness/source-paseo.js";

const exec = promisify(execFile);
const sourceTests = describe.runIf(process.env["RUN_HUB_E2E"] === "1");
const ToolResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});
const WorkerSchema = z.object({
  daemonId: z.string(),
  agentId: z.string(),
  workspaceId: z.string(),
  promptAccepted: z.literal(true),
});

sourceTests("Hub MCP with exact source-built Paseo", () => {
  it("runs parallel workers, replays durable requests, reads results after reconnect, and archives explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-mcp-source-"));
    const { runtime, locks } = await embeddedDatabaseRuntime(join(root, "database"));
    await runtime.migrate();
    const database = createDatabase(runtime, locks);
    const entitlements = composeEntitlements(database, runtime);
    const built = await loadBuiltStartServer();
    const http = createFetchServer((request) => built.default.fetch(request));
    http.on("upgrade", (request, socket, head) => {
      void built.handleDaemonUpgrade(request, socket, head);
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const auth = createAuthServer({
      database: runtime,
      locks,
      entitlements: entitlements.service,
      secret: "hub-mcp-source-test-secret-at-least-32-chars",
      baseURL: origin,
    });
    await runtime.query(
      `insert into "user" (id, name, email) values ('operator', 'Operator', 'operator@hub.test')`,
    );
    await runtime.query(
      `insert into organization (id, name, slug) values ('org', 'Organization', 'org')`,
    );
    await runtime.query(
      `insert into member (id, organization_id, user_id, role) values ('owner', 'org', 'operator', 'owner')`,
    );
    const key = await auth.apiKeys!.create("org", "operator", "MCP source test", [
      "agents:read",
      "agents:control",
      "daemons:enroll",
    ]);
    const application = await createApplicationRuntime({
      database,
      auth,
      entitlements: entitlements.service,
      billing: null,
      publicBaseUrl: origin,
      async close() {
        await auth.close();
        await entitlements.close();
        await database.close();
      },
    });
    await built.startApplication(() => application);
    let source: SourcePaseo | undefined;
    let client: Client | undefined;
    async function connectClient() {
      const next = new Client({ name: "generic-assistant", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${origin}/api/v1/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key.secret}` } },
      });
      // @ts-expect-error upstream SDK exactOptionalPropertyTypes mismatch
      await next.connect(transport);
      return next;
    }
    async function call(name: string, args: Record<string, unknown>) {
      assert(client);
      const result = ToolResultSchema.parse(await client.callTool({ name, arguments: args }));
      assert(!result.isError, result.content[0]?.text);
      return z.record(z.string(), z.unknown()).parse(JSON.parse(result.content[0]?.text ?? "{}"));
    }
    try {
      const repo = join(root, "repo");
      await mkdir(repo);
      await exec("git", ["init", "-b", "main", repo]);
      await writeFile(join(repo, "README.md"), "MCP test repository\n");
      await exec("git", ["-C", repo, "add", "README.md"]);
      await exec("git", [
        "-C",
        repo,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@hub.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "Initial",
      ]);
      source = await SourcePaseo.start({
        root,
        config: ({ packagesRoot, daemonHost }) => ({
          version: 1,
          daemon: {
            listen: daemonHost,
            relay: { enabled: false },
            mcp: { enabled: false, injectIntoAgents: false },
            cors: { allowedOrigins: [] },
          },
          agents: {
            providers: {
              "hub-e2e": {
                extends: "acp",
                label: "Hub E2E",
                command: [process.execPath, resolve("src/e2e/harness/acp-agent.mjs")],
                env: {
                  NODE_OPTIONS: "",
                  HUB_E2E_ACP_SDK: join(
                    packagesRoot,
                    "node_modules/@agentclientprotocol/sdk/dist/acp.js",
                  ),
                  HUB_E2E_ACP_RECORD_FILE: join(root, "requests.jsonl"),
                  HUB_E2E_COMPLETE_GATE: join(root, "gate"),
                  HUB_E2E_COMPLETION_JOBS: join(root, "jobs"),
                },
              },
            },
          },
          features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
        }),
      });
      const enrolled = await source.connectWithCredential(origin, key.secret);
      const daemonId = z.string().parse(enrolled["daemonId"]);
      await source.run([
        "hub",
        "permissions",
        "grant",
        "hub.execute",
        "--host",
        source.paths.daemonHost,
        "--json",
      ]);
      await waitFor(async () => application.hub.connectionForDaemon(daemonId) !== undefined);
      client = await connectClient();
      assert.equal((await client.listTools()).tools.length, 11);
      const providers = await call("get_providers", { daemonId, cwd: repo });
      assert.match(JSON.stringify(providers), /hub-e2e/u);
      const args = {
        daemonId,
        requestKey: "worker-1",
        provider: "hub-e2e",
        modeId: "default",
        cwd: repo,
        prompt: "Deploy mcp-worker for testing.",
      };
      const workers = await Promise.all([
        call("create_agent", args),
        call("create_agent", { ...args, requestKey: "worker-2" }),
      ]);
      const first = WorkerSchema.parse(workers[0]);
      const second = WorkerSchema.parse(workers[1]);
      assert.notEqual(first.agentId, second.agentId);
      assert.notEqual(first.workspaceId, second.workspaceId);
      assert.equal(WorkerSchema.parse(await call("create_agent", args)).agentId, first.agentId);
      await waitFor(
        async () =>
          (await call("get_agent", { daemonId, agentId: first.agentId }))["status"] === "idle",
      );
      const prompts = (await readFile(join(root, "requests.jsonl"), "utf8")).trim().split("\n");
      assert.equal(prompts.length, 2, "replaying creation must not send the initial prompt twice");
      await client.close();
      client = await connectClient();
      const activity = await call("get_agent_activity", { daemonId, agentId: first.agentId });
      assert.match(JSON.stringify(activity), /phase-five:mcp-worker/u);
      const details = await call("get_agent", { daemonId, agentId: first.agentId });
      const cwd = z.string().parse(details["cwd"]);
      assert.notEqual(cwd, repo);
      const branch = (await exec("git", ["-C", cwd, "branch", "--show-current"])).stdout.trim();
      await call("send_agent_message", {
        daemonId,
        agentId: first.agentId,
        messageKey: "follow-up",
        text: "Deploy mcp-follow-up for testing.",
      });
      await waitFor(
        async () =>
          (await call("get_agent", { daemonId, agentId: first.agentId }))["status"] === "idle",
      );
      assert.match(
        JSON.stringify(await call("get_agent_activity", { daemonId, agentId: first.agentId })),
        /phase-five:mcp-follow-up/u,
      );
      await call("interrupt_agent", { daemonId, agentId: second.agentId });
      await call("archive_agent", { daemonId, agentId: first.agentId });
      assert((await call("get_agent", { daemonId, agentId: first.agentId }))["archivedAt"]);
      // Agent archive retains the managed worktree. Workspace archive is explicit cleanup.
      await writeFile(join(cwd, "uncommitted.txt"), "Preserved until workspace archive\n");
      await call("archive_workspace", { daemonId, workspaceId: first.workspaceId });
      await assert.rejects(access(cwd), { code: "ENOENT" });
      await exec("git", ["-C", repo, "show-ref", "--verify", `refs/heads/${branch}`]);
      await call("archive_workspace", { daemonId, workspaceId: second.workspaceId });
    } finally {
      await client?.close();
      await source?.stop();
      await built.stopProductionRuntime();
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      await rm(root, { recursive: true, force: true });
    }
  }, 600_000);
});
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("MCP daemon condition timed out");
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}
