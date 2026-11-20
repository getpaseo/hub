import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { TRUSTED_REQUEST_ORIGIN_HEADER } from "../http/request-origin.js";
import { createMemoryDatabase } from "../db/memory.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { TriggerDashboard } from "./dashboard.js";
import { OrganizationTriggerStore } from "./store.js";

describe("trigger dashboard read model", () => {
  it("describes the provider and latest run on the organization trigger list", async () => {
    const database = memberDatabase();
    await enrollTestDaemon(database, "org-1");
    const trigger = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({
      yaml: triggerYaml,
      userId: "user-1",
    });
    const dashboard = new TriggerDashboard(
      database,
      accountAuth(),
      acceptingAgentValidator(),
      "http://localhost:3000",
    );
    const request = new Request("http://localhost:3000/o/acme/triggers", {
      headers: { [TRUSTED_REQUEST_ORIGIN_HEADER]: "https://hub.test" },
    });

    const before = await dashboard.snapshot(request, "acme");
    assert.equal(before.webhookOrigin, "https://hub.test");
    assert.equal(before.triggers[0]?.provider, "manual");
    assert.equal(before.triggers[0]?.event, "manual.run");
    assert.equal(before.triggers[0]?.lastTriggered, null);

    const revision = await database.findActiveProjectConfiguration(trigger.runtimeProjectId);
    assert.ok(revision);
    const receivedAt = new Date("2026-08-30T09:30:00.000Z");
    const receipt = await database.persistManualEvent({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      deliveryId: "dashboard-manual-run",
      source: "manual.run",
      payload: {},
      receivedAt,
    });
    assert.equal(receipt.status, "accepted");
    if (receipt.status !== "accepted") return;
    await database.createAcceptedTriggerRun({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "manual-task",
      prompt: "run it",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date("2026-08-30T10:30:00.000Z"),
      stepIds: ["run"],
    });

    const after = await dashboard.snapshot(request, "acme");
    assert.deepEqual(after.triggers[0]?.lastTriggered, {
      status: "running",
      receivedAt: receivedAt.toISOString(),
    });
  });
  it("labels a YAML-only webhook with its saved event before any deliveries", async () => {
    const database = memberDatabase();
    await enrollTestDaemon(database, "org-1");
    const yaml = triggerYaml
      .replace("manual.run", "webhook.received")
      .replace(
        "agent: { provider: codex, mode: full-access }",
        "agent: { select: coding, choices: { coding: { provider: codex, mode: full-access } } }",
      );
    await new OrganizationTriggerStore(database, "org-1", acceptingAgentValidator()).save({
      yaml,
      userId: "user-1",
    });

    const snapshot = await new TriggerDashboard(
      database,
      accountAuth(),
      acceptingAgentValidator(),
    ).snapshot(new Request("https://hub.test/o/acme/triggers"), "acme");
    assert.equal(snapshot.triggers[0]?.event, "webhook.received");
    assert.equal(snapshot.triggers[0]?.provider, "webhook");
    assert.equal(snapshot.triggers[0]?.draft, null);
  });
});

const triggerYaml = `name: manual-task
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
`;

function memberDatabase() {
  return createMemoryDatabase({
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
  });
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
