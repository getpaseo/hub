import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { z } from "zod";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { OrganizationApiKeys } from "../auth/api-keys.js";
import { OrganizationCliCredentials } from "../auth/cli-credentials.js";
import { PublicCredentialAuthenticator } from "../auth/public-credentials.js";
import { createHubMcp } from "./index.js";
import { takeResponseLifecycle } from "../http/response-lifecycle.js";

it("persists new MCP scopes and enforces real credential revocation on embedded storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-mcp-credentials-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(join(root, "database"));
  try {
    await runtime.migrate();
    await runtime.query(
      `insert into "user" (id, name, email) values ('user', 'User', 'user@hub.test')`,
    );
    await runtime.query(
      `insert into organization (id, name, slug) values ('org', 'Organization', 'org')`,
    );
    const keys = new OrganizationApiKeys(runtime, locks);
    const cli = new OrganizationCliCredentials(runtime);
    const cliPrefix = "paseo_cli_abcdefghijkl";
    const cliSecret = `${cliPrefix}_test-secret`;
    await runtime.query(
      `insert into organization_cli_credentials (id, organization_id, prefix, verifier, created_by_user_id)
       values ('60000000-0000-4000-8000-000000000001', 'org', $1, $2, 'user')`,
      [cliPrefix, createHash("sha256").update(cliSecret).digest("base64url")],
    );
    const key = await keys.create("org", "user", "MCP", ["agents:read", "agents:control"]);
    const mcp = createHubMcp({
      composition: {
        status: "enabled",
        authenticator: new PublicCredentialAuthenticator(keys, cli),
      },
      database: {
        findDaemonForOrganization: async () => undefined,
        listDaemonsForOrganization: async () => [],
      },
      connectionForDaemon: () => undefined,
      operations: {
        listProjects: async () => ({ status: "listed", projects: [] }),
        dispatchManualRun: async () => ({ status: "project_not_found" }),
      },
    });
    const request = (secret = key.secret) =>
      new Request("https://hub.test/api/v1/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const response = await mcp.handle(request());
    try {
      assert.equal(response.status, 200);
      const body = z
        .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
        .parse(await response.json());
      assert.equal(body.result.tools.length, 11);
    } finally {
      await takeResponseLifecycle(response)?.onFinish();
    }
    await keys.revoke("org", key.summary.id);
    assert.equal((await mcp.handle(request())).status, 401);
    const cliResponse = await mcp.handle(request(cliSecret));
    try {
      assert.equal(cliResponse.status, 200);
      const body = z
        .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
        .parse(await cliResponse.json());
      assert.deepEqual(
        body.result.tools.map((tool) => tool.name),
        ["list_projects", "dispatch_manual_run"],
      );
      assert.equal((await cli.authorize(request(cliSecret), "agents:control")).status, "forbidden");
    } finally {
      await takeResponseLifecycle(cliResponse)?.onFinish();
    }
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
