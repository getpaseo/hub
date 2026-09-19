import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import { buildLaunchMachineIntent } from "../dispatcher/index.js";
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
    assert.deepEqual(snapshot.runs, []);
    assert.deepEqual(snapshot.unrouted, []);
    assert.equal(snapshot.windowDays, 7);
  });

  it("reads daemons with whether they can run agents, triggers with their event, and recent runs with the agent that ran", async () => {
    const database = memberDatabase();
    await enrollTestDaemon(database, "org-1");
    await enrollConnectedOnlyDaemon(database);
    await database.setDaemonPresence(TEST_DAEMON_ID, "connected");
    const trigger = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({ yaml: triggerYaml, userId: "user-1" });
    await recordRun(database, trigger.runtimeProjectId, "first", "succeeded", 120_000);
    await recordRun(database, trigger.runtimeProjectId, "second", "failed", 60_000);

    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      APPS_CONFIGURED,
      () => NOW,
    ).snapshot(request, "acme");

    assert.deepEqual(snapshot.connections, [
      { provider: "slack", slug: "acme-slack", label: "Acme Slack" },
    ]);
    assert.deepEqual(snapshot.daemons, [
      { id: TEST_DAEMON_ID, slug: TEST_DAEMON_SLUG, presence: "connected", canExecute: true },
      { id: CONNECTED_ONLY_DAEMON_ID, slug: "laptop", presence: "offline", canExecute: false },
    ]);
    assert.deepEqual(snapshot.triggers, [
      { id: trigger.id, name: "manual-task", event: "manual.run", enabled: true },
    ]);
    assert.deepEqual(
      snapshot.runs.map(({ triggerName, provider, source, status, agent }) => ({
        triggerName,
        provider,
        source,
        status,
        agent,
      })),
      [
        {
          triggerName: "manual-task",
          provider: "manual",
          source: "manual.run",
          status: "failed",
          agent: { provider: "codex", model: "gpt-5.4" },
        },
        {
          triggerName: "manual-task",
          provider: "manual",
          source: "manual.run",
          status: "succeeded",
          agent: { provider: "codex", model: "gpt-5.4" },
        },
      ],
    );
  });

  it("counts provider events dropped for want of a trigger, per provider, inside the window", async () => {
    const database = memberDatabase();
    await dropSlackEvent(database, "recent-1", new Date("2026-09-20T12:00:00.000Z"));
    await dropSlackEvent(database, "recent-2", new Date("2026-09-21T09:00:00.000Z"));
    await dropSlackEvent(database, "stale", new Date("2026-09-01T12:00:00.000Z"));
    // A filter rejection is a trigger listening and declining, so it is not a missing trigger.
    await dropSlackEvent(
      database,
      "filtered",
      new Date("2026-09-21T10:00:00.000Z"),
      "trigger_filters_rejected",
    );

    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      APPS_CONFIGURED,
      () => NOW,
    ).snapshot(request, "acme");

    assert.deepEqual(snapshot.unrouted, [{ provider: "slack", count: 2 }]);
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

async function recordRun(
  database: Database,
  projectId: string,
  deliveryId: string,
  status: "succeeded" | "failed",
  ageMs: number,
): Promise<void> {
  const revision = await database.findActiveProjectConfiguration(projectId);
  assert.ok(revision);
  const receipt = await database.persistManualEvent({
    organizationId: "org-1",
    projectId,
    deliveryId,
    source: "manual.run",
    payload: {},
    receivedAt: new Date(NOW.getTime() - ageMs),
  });
  assert.equal(receipt.status, "accepted");
  if (receipt.status !== "accepted") return;
  const { run } = await database.createAcceptedTriggerRun({
    organizationId: "org-1",
    projectId,
    configurationRevisionId: revision.id,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    configuredTriggerName: "manual-task",
    prompt: "run it",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    deadlineAt: new Date(NOW.getTime() + 3_600_000),
    stepIds: ["run"],
    createdAt: new Date(NOW.getTime() - ageMs),
  });
  const executionId = `execution-${deliveryId}`;
  await database.createWorkflowStepExecution({
    triggerRunId: run.id,
    stepId: "run",
    ordinal: 0,
    executionId,
    execution: {
      id: executionId,
      organizationId: "org-1",
      projectId,
      machineId: null,
      daemonId: TEST_DAEMON_ID,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: revision.id,
      deadlineAt: new Date(NOW.getTime() + 3_600_000),
      idleDeadlineAt: new Date(NOW.getTime() + 600_000),
      startedAt: new Date(NOW.getTime() - 30_000),
      launchIntent: buildLaunchMachineIntent({
        organizationId: "org-1",
        projectId,
        triggerRunId: run.id,
        configurationRevisionId: revision.id,
        triggerName: "manual-task",
        environmentName: "target",
        environment: {
          kind: "daemon",
          daemonId: TEST_DAEMON_ID,
          authoredSlug: TEST_DAEMON_SLUG,
          cwd: "/workspace",
        },
        prompt: "run it",
        agent: { provider: "codex", model: "gpt-5.4", mode: "full-access" },
        allowOutputs: [],
        autoArchive: true,
        triggerContext: {},
        outputContext: {},
        hubConfig: {},
      }),
    },
  });
  if (status === "succeeded") await database.succeedTriggerRun(run.id);
  else await database.failWorkflowRun(run.id, "failed", "agent_interrupted", "run");
}

async function dropSlackEvent(
  database: Database,
  deliveryId: string,
  receivedAt: Date,
  reason = "no_project_route",
): Promise<void> {
  const accepted = await database.acceptSlackEvent({
    teamId: "T-ACME",
    deliveryId,
    source: "slack.mention",
    payload: {},
    receivedAt,
    dropReason: reason,
  });
  assert.equal(accepted.status, "dropped");
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
