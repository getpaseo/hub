import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import {
  enrollTestDaemon,
  TEST_DAEMON_ID,
  TEST_DAEMON_SLUG,
} from "../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { HomeDashboard } from "./dashboard.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const APPS_CONFIGURED = () => true;
const request = new Request("https://hub.test/o/acme/home");

describe("home read model", () => {
  it("describes a fresh organization as nothing connected and nothing run", async () => {
    const database = memberDatabase({ slack: false });
    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      APPS_CONFIGURED,
      () => NOW,
    ).snapshot(request, "acme");

    assert.equal(snapshot.appsConfigured, true);
    assert.deepEqual(snapshot.connections, []);
    assert.deepEqual(snapshot.daemons, []);
    assert.deepEqual(snapshot.triggers, []);
    assert.equal(snapshot.range, "7d");
    assert.equal(snapshot.latestRun, null);
  });

  it("reads connections, daemons with whether they can run agents, and triggers with their events", async () => {
    const database = memberDatabase();
    await enrollTestDaemon(database, "org-1");
    await enrollConnectedOnlyDaemon(database);
    await database.setDaemonPresence(TEST_DAEMON_ID, "connected");
    const { trigger } = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({ yaml: triggerYaml, userId: "user-1" });

    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      APPS_CONFIGURED,
      () => NOW,
    ).snapshot(request, "acme");

    assert.deepEqual(snapshot.connections, [
      // The fixture's workspace granted `app_mentions:read` only, short of what Hub requires.
      {
        provider: "slack",
        slug: "acme-slack",
        label: "Acme Slack",
        status: "requiresReauthorization",
      },
    ]);
    assert.deepEqual(snapshot.daemons, [
      {
        id: TEST_DAEMON_ID,
        slug: TEST_DAEMON_SLUG,
        presence: "connected",
        canExecute: true,
        runs: 0,
      },
      {
        id: CONNECTED_ONLY_DAEMON_ID,
        slug: "laptop",
        presence: "offline",
        canExecute: false,
        runs: 0,
      },
    ]);
    assert.deepEqual(snapshot.triggers, [
      { id: trigger.id, name: "manual-task", events: ["manual.run"], enabled: true },
    ]);
  });

  it("reads every event of a YAML-only trigger with agent choices", async () => {
    const database = memberDatabase();
    await enrollTestDaemon(database, "org-1");
    const yaml = scheduledTriggerYaml
      .replace("manual.run", "webhook.received")
      .replace(
        "agent: { provider: codex, model: gpt-5.4, mode: full-access }",
        "agent: { select: coding, choices: { coding: { provider: codex, mode: full-access } } }",
      );
    await new OrganizationTriggerStore(database, "org-1", acceptingAgentValidator()).save({
      yaml,
      userId: "user-1",
    });
    const snapshot = await new HomeDashboard(database, accountAuth(), APPS_CONFIGURED).snapshot(
      request,
      "acme",
    );
    assert.deepEqual(snapshot.triggers[0]?.events, ["schedule.tick", "webhook.received"]);
  });

  it("asks the provider registrations whether any app is configured, with the organization's bindings", async () => {
    const database = memberDatabase();
    const seen: unknown[] = [];
    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      (bindings) => {
        seen.push(bindings.slack.map(({ slug }) => slug));
        return false;
      },
      () => NOW,
    ).snapshot(request, "acme");

    assert.equal(snapshot.appsConfigured, false);
    assert.deepEqual(seen, [["acme-slack"]]);
  });
});

const CONNECTED_ONLY_DAEMON_ID = "20000000-0000-4000-8000-000000000002";

function memberDatabase({ slack = true }: { slack?: boolean } = {}): Database {
  return createMemoryDatabase({
    now: () => NOW,
    memberships: [
      {
        userId: "user-1",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "membership-1",
        role: "owner",
      },
    ],
    slackConnections: slack
      ? [
          {
            id: "slack-1",
            organizationId: "org-1",
            slug: "acme-slack",
            teamId: "T-ACME",
            teamName: "Acme Slack",
            botUserId: "UBOT",
            botAccessToken: "token",
            scopes: ["app_mentions:read"],
            providerApplicationId: null,
          },
        ]
      : [],
  });
}

/** A daemon enrolled with the CLI's default answer of No to running Hub automations. */
async function enrollConnectedOnlyDaemon(database: Database): Promise<void> {
  await database.issueEnrollmentToken({
    id: "connected-only-token",
    verifier: "connected-only-verifier",
    organizationId: "org-1",
    expiresAt: new Date("2026-09-22T00:00:00.000Z"),
    consumedAt: null,
  });
  await database.enrollDaemon({
    tokenVerifier: "connected-only-verifier",
    daemonId: CONNECTED_ONLY_DAEMON_ID,
    idempotencyKey: "connected-only",
    suggestedSlug: "laptop",
    serverId: "server-2",
    daemonPublicKey: "public-key",
    credentialVerifier: "credential-verifier",
    permissions: [],
    now: new Date("2026-09-21T11:00:00.000Z"),
  });
}

const triggerYaml = `name: manual-task
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: codex, model: gpt-5.4, mode: full-access }
  prompt: Handle it
`;

/** A schedule declared before the manual event, so the schedule compiles under an internal name. */
const scheduledTriggerYaml = triggerYaml.replace(
  "on:\n",
  `on:
  schedule.tick:
    recurrence: { start: "2026-01-01T09:00:00", rule: "FREQ=DAILY", timezone: UTC }
`,
);

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
