import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { ProjectDashboard } from "./dashboard.js";

describe("project dashboard activity read models", () => {
  it("omits a large receipt payload from the list and retains it in detail", async () => {
    const database = createMemoryDatabase({
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
    const project = await database.createProject({
      organizationId: "org-1",
      name: "Hub",
      slug: "hub",
      createdByUserId: "user-1",
    });
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "dashboard-read-model",
    });
    await database.activateProjectConfigurationRevision(project.id, revision.id, []);
    const rawPayload = { body: "payload-".repeat(20_000) };
    const receipt = await database.persistManualEvent({
      organizationId: "org-1",
      projectId: project.id,
      deliveryId: "dashboard-large-payload",
      source: "manual.dashboard",
      payload: rawPayload,
      receivedAt: new Date("2026-08-06T12:00:00.000Z"),
    });
    if (receipt.status !== "accepted") throw new Error("dashboard receipt was not accepted");
    const run = await database.createAcceptedTriggerRun({
      organizationId: "org-1",
      projectId: project.id,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "dashboard-run",
      rawPrompt: "run",
      prompt: "run",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date("2026-08-06T13:00:00.000Z"),
      stepIds: ["step"],
    });
    const dashboard = new ProjectDashboard(database, accountAuth(), undefined);
    const request = new Request("https://hub.test/o/acme/projects/hub");
    const list = await dashboard.projectSnapshot(request, {
      organizationSlug: "acme",
      projectSlug: "hub",
    });
    assert.equal("rawPayload" in list.activity[0]!, false);

    const detail = await dashboard.activityRunSnapshot(request, {
      organizationSlug: "acme",
      projectSlug: "hub",
      runId: run.run.id,
    });
    assert.deepEqual(detail.activity.rawPayload, rawPayload);
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
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
