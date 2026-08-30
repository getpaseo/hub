import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ForgejoAuthorityError } from "../../config/forgejo-authority.js";
import { createForgejoOutcomeClient } from "./outcome-client.js";

const EXECUTION_TOKEN = "fj_exec_pat_canary_outcome";
const CONNECTION_TOKEN = "fj_conn_pat_must_never_be_sent";

function grant() {
  return {
    repositories: ["t00org/t00repo"],
    contents: "write" as const,
    issues: "write" as const,
  };
}

describe("Forgejo outcome client", () => {
  it("reads and writes contents with the execution PAT under repository grant", async () => {
    const calls: Array<{ url: string; authorization: string | null; method: string }> = [];
    const client = createForgejoOutcomeClient({
      origin: "https://forgejo.example.test",
      token: EXECUTION_TOKEN,
      grant: grant(),
      fetch: async (input, init) => {
        let url: string;
        if (typeof input === "string") url = input;
        else if (input instanceof URL) url = input.href;
        else url = input.url;
        const headers = new Headers(init?.headers);
        calls.push({
          url,
          authorization: headers.get("authorization"),
          method: init?.method ?? "GET",
        });
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ content: { sha: "created-sha" } }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            sha: "0c612cc8319c95ab9d9f736f3a6fdebfd5389751",
            content: "IyB0MDByZXBv",
            encoding: "base64",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const file = await client.readFile({
      connectionId: "conn-1",
      owner: "t00org",
      repo: "t00repo",
      path: "README.md",
      ref: "main",
    });
    assert.deepEqual(file, {
      sha: "0c612cc8319c95ab9d9f736f3a6fdebfd5389751",
      content: "IyB0MDByZXBv",
      encoding: "base64",
    });
    const created = await client.createFile({
      connectionId: "conn-1",
      owner: "t00org",
      repo: "t00repo",
      path: "NOTES.md",
      content: "hello",
      message: "add notes",
      newBranch: "agent-branch",
    });
    assert.deepEqual(created, { sha: "created-sha" });
    assert.deepEqual(
      calls.map((call) => call.authorization),
      [`token ${EXECUTION_TOKEN}`, `token ${EXECUTION_TOKEN}`],
    );
    assert.equal(
      calls.some((call) => call.authorization?.includes(CONNECTION_TOKEN)),
      false,
    );
  });

  it("denies contents write and out-of-grant repositories without sending a request", async () => {
    let requested = false;
    const readOnly = createForgejoOutcomeClient({
      origin: "https://forgejo.example.test",
      token: EXECUTION_TOKEN,
      grant: { ...grant(), contents: "read", issues: "read" },
      fetch: async () => {
        requested = true;
        return new Response("{}", { status: 200 });
      },
    });
    await assert.rejects(
      () =>
        readOnly.createFile({
          connectionId: "conn-1",
          owner: "t00org",
          repo: "t00repo",
          path: "NOTES.md",
          content: "hello",
          message: "add notes",
        }),
      (error: unknown) =>
        error instanceof ForgejoAuthorityError && error.code === "forgejo_scope_invalid",
    );
    await assert.rejects(
      () =>
        readOnly.createIssueComment({
          connectionId: "conn-1",
          owner: "t00org",
          repo: "t00repo",
          index: 3,
          body: "done",
        }),
      (error: unknown) =>
        error instanceof ForgejoAuthorityError && error.code === "forgejo_scope_invalid",
    );
    await assert.rejects(
      () =>
        readOnly.readFile({
          connectionId: "conn-1",
          owner: "other",
          repo: "secret",
          path: "README.md",
        }),
      (error: unknown) =>
        error instanceof ForgejoAuthorityError && error.code === "forgejo_repository_unenrolled",
    );
    assert.equal(requested, false);
  });

  it("maps upstream 403 to typed denial without copying the token or provider message", async () => {
    const client = createForgejoOutcomeClient({
      origin: "https://forgejo.example.test",
      token: EXECUTION_TOKEN,
      grant: grant(),
      fetch: async () =>
        new Response(JSON.stringify({ message: `token ${EXECUTION_TOKEN} rejected` }), {
          status: 403,
        }),
    });
    await assert.rejects(
      () =>
        client.createIssueComment({
          connectionId: "conn-1",
          owner: "t00org",
          repo: "t00repo",
          index: 3,
          body: "done",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ForgejoAuthorityError);
        assert.equal(error.code, "forgejo_scope_invalid");
        assert.equal(error.message.includes(EXECUTION_TOKEN), false);
        return true;
      },
    );
  });
});
