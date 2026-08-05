import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import { ProjectCommandError, ProjectDashboard } from "./dashboard.js";

describe("project dashboard trigger/execution payload access", () => {
  it("excludes raw trigger payload and execution result from the project snapshot", async () => {
    const { dashboard, database, project } = await seededProject();
    await database.insertTrigger({
      organizationId: "org-1",
      projectId: project.id,
      deliveryId: "delivery-1",
      source: "manual.run",
      payload: { secret: "should not appear in the snapshot" },
      receivedAt: new Date(),
    });

    const snapshot = await dashboard.projectSnapshot(new Request("https://hub.test"), {
      organizationSlug: "acme",
      projectSlug: "default",
    });

    assert.equal(snapshot.activity.length, 1);
    assert.equal("payload" in snapshot.activity[0]!, false);
  });

  it("fetches a trigger's raw payload only when it belongs to the requested project", async () => {
    const { dashboard, database, project } = await seededProject();
    const otherProject = await database.createProject({
      organizationId: "org-1",
      name: "Other",
      slug: "other",
      createdByUserId: "user-1",
    });
    const owned = await database.insertTrigger({
      organizationId: "org-1",
      projectId: project.id,
      deliveryId: "delivery-owned",
      source: "manual.run",
      payload: { trigger: "deploy" },
      receivedAt: new Date(),
    });
    const foreign = await database.insertTrigger({
      organizationId: "org-1",
      projectId: otherProject.id,
      deliveryId: "delivery-foreign",
      source: "manual.run",
      payload: { trigger: "rollback" },
      receivedAt: new Date(),
    });

    const payload = await dashboard.triggerPayload(
      new Request("https://hub.test"),
      { organizationSlug: "acme", projectSlug: "default" },
      owned.trigger.id,
    );
    assert.deepEqual(payload, { trigger: "deploy" });

    await assert.rejects(
      dashboard.triggerPayload(
        new Request("https://hub.test"),
        { organizationSlug: "acme", projectSlug: "default" },
        foreign.trigger.id,
      ),
      (error: unknown) =>
        error instanceof ProjectCommandError && error.code === "trigger_unavailable",
    );
  });

  it("fetches an execution's raw result only when it belongs to the requested project", async () => {
    const { dashboard, database, project, revisionId } = await seededProject();
    const otherProject = await database.createProject({
      organizationId: "org-1",
      name: "Other",
      slug: "other",
      createdByUserId: "user-1",
    });
    const otherRevision = await database.insertProjectConfigurationRevision({
      projectId: otherProject.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: {},
      contentHash: "other-config",
    });
    const owned = await database.insertAgentExecution({
      organizationId: "org-1",
      projectId: project.id,
      machineId: null,
      triggerContext: null,
      outputContext: null,
      configurationRevisionId: revisionId,
    });
    await database.transitionAgentExecution(owned.id, "succeeded", {
      result: { status: "succeeded" },
    });
    const foreign = await database.insertAgentExecution({
      organizationId: "org-1",
      projectId: otherProject.id,
      machineId: null,
      triggerContext: null,
      outputContext: null,
      configurationRevisionId: otherRevision.id,
    });

    const result = await dashboard.executionResult(
      new Request("https://hub.test"),
      { organizationSlug: "acme", projectSlug: "default" },
      owned.id,
    );
    assert.deepEqual(result, { status: "succeeded" });

    await assert.rejects(
      dashboard.executionResult(
        new Request("https://hub.test"),
        { organizationSlug: "acme", projectSlug: "default" },
        foreign.id,
      ),
      (error: unknown) =>
        error instanceof ProjectCommandError && error.code === "execution_unavailable",
    );
  });
});

async function seededProject(): Promise<{
  dashboard: ProjectDashboard;
  database: Database;
  project: Awaited<ReturnType<Database["createProject"]>>;
  revisionId: string;
}> {
  const database = createMemoryDatabase({
    memberships: [
      {
        userId: "user-1",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "member-1",
        role: "owner",
      },
    ],
  });
  const project = await database.createProject({
    organizationId: "org-1",
    name: "Default",
    slug: "default",
    createdByUserId: "user-1",
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: {},
    contentHash: "test-config",
  });
  const dashboard = new ProjectDashboard(database, accountAuth(), undefined);
  return { dashboard, database, project, revisionId: revision.id };
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
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
