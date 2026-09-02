import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { enrollTestDaemon, TEST_DAEMON_ID } from "../test-utils/project-configuration.js";
import type { DaemonConnection } from "./protocol.js";
import { DaemonProviderCatalog } from "./provider-catalog.js";

describe("daemon provider catalog", () => {
  it("authorizes the organization and refreshes before returning its daemon snapshot", async () => {
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user-1",
          organizationId: "org-1",
          organizationName: "Acme",
          organizationSlug: "acme",
          membershipId: "membership-1",
          role: "member",
        },
      ],
    });
    await enrollTestDaemon(database, "org-1");
    const calls: string[] = [];
    const connection: DaemonConnection = {
      createAgent: async () => {
        throw new Error("not used");
      },
      controlExecution: async () => undefined,
      on: () => () => undefined,
      refreshProviderSnapshot: async ({ cwd }) => {
        calls.push(`refresh:${cwd}`);
      },
      getProviderSnapshot: async ({ cwd }) => {
        calls.push(`get:${cwd}`);
        return {
          requestId: "snapshot-1",
          ...(cwd === undefined ? {} : { cwd }),
          entries: [{ provider: "codex", status: "ready", enabled: true }],
          generatedAt: "2026-09-02T12:00:00.000Z",
        };
      },
    };
    const catalog = new DaemonProviderCatalog(database, accountAuth(), (daemonId) =>
      daemonId === TEST_DAEMON_ID ? connection : undefined,
    );

    const result = await catalog.read(new Request("https://hub.test/o/acme/triggers"), {
      organizationSlug: "acme",
      daemonId: TEST_DAEMON_ID,
      cwd: "/repo",
      refresh: true,
    });

    assert.deepEqual(calls, ["refresh:/repo", "get:/repo"]);
    assert.equal(result.entries[0]?.provider, "codex");
  });
});

function accountAuth(): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: "org-1" },
        account: { id: "user-1", name: "User", email: "user@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
