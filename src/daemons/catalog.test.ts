import { DaemonAgents } from "./agents/index.js";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { enrollTestDaemon, TEST_DAEMON_ID } from "../test-utils/project-configuration.js";
import type { DaemonConnection } from "./protocol.js";
import { DaemonCatalog } from "./catalog.js";

describe("daemon catalog", () => {
  it("authorizes the organization and refreshes before returning its daemon snapshot", async () => {
    const { catalog, calls } = await catalogFor(connectedDaemon());

    const result = await catalog.providers(new Request("https://hub.test/o/acme/triggers"), {
      organizationSlug: "acme",
      daemonId: TEST_DAEMON_ID,
      cwd: "/repo",
      refresh: true,
    });

    assert.deepEqual(calls, ["refresh:/repo", "get:/repo"]);
    assert.equal(result.entries[0]?.provider, "codex");
  });

  it("lists the daemon's projects for a member of its organization", async () => {
    const { catalog } = await catalogFor(connectedDaemon());

    assert.deepEqual(
      await catalog.projects(new Request("https://hub.test/o/acme/triggers"), {
        organizationSlug: "acme",
        daemonId: TEST_DAEMON_ID,
      }),
      [{ id: "project-1", name: "hub", rootPath: "/home/dev/hub" }],
    );
  });

  it("offers no projects while the daemon is offline", async () => {
    const { catalog } = await catalogFor(undefined);

    assert.deepEqual(
      await catalog.projects(new Request("https://hub.test/o/acme/triggers"), {
        organizationSlug: "acme",
        daemonId: TEST_DAEMON_ID,
      }),
      [],
    );
  });

  it("does not list projects for a daemon outside the organization", async () => {
    const { catalog } = await catalogFor(connectedDaemon());

    await assert.rejects(
      catalog.projects(new Request("https://hub.test/o/acme/triggers"), {
        organizationSlug: "acme",
        daemonId: "22222222-2222-4222-8222-222222222222",
      }),
      /daemon_unavailable/u,
    );
  });
});

function connectedDaemon(): { connection: DaemonConnection; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    connection: {
      agents: new DaemonAgents(() => {
        throw new Error("Native agents are not used by this fixture");
      }),
      refreshProviderSnapshot: async ({ cwd }) => {
        calls.push(`refresh:${cwd}`);
      },
      validateAgentConfiguration: async () => ({ valid: true }),
      getProviderSnapshot: async ({ cwd }) => {
        calls.push(`get:${cwd}`);
        return {
          requestId: "snapshot-1",
          ...(cwd === undefined ? {} : { cwd }),
          entries: [{ provider: "codex", status: "ready", enabled: true }],
          generatedAt: "2026-09-02T12:00:00.000Z",
        };
      },
      listProjects: async () => [{ id: "project-1", name: "hub", rootPath: "/home/dev/hub" }],
    },
  };
}

async function catalogFor(daemon: ReturnType<typeof connectedDaemon> | undefined) {
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
  return {
    calls: daemon?.calls ?? [],
    catalog: new DaemonCatalog(database, accountAuth(), (daemonId) =>
      daemonId === TEST_DAEMON_ID ? daemon?.connection : undefined,
    ),
  };
}

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
