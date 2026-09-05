import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import type { LinearConnectionRecord } from "./types.js";

describe("Linear event acceptance", () => {
  it("routes a stop to matching active session work after its current route is removed", async () => {
    const database = createMemoryDatabase();
    const connection: LinearConnectionRecord = {
      id: "00000000-0000-4000-8000-000000000001",
      organizationId: "org-1",
      slug: "linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Linear",
      appUserId: "linear-app-user",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: null,
      scopes: ["read", "write", "app:assignable", "app:mentionable"],
    };
    database.findLinearConnection = async (linearOrganizationId) =>
      linearOrganizationId === connection.linearOrganizationId ? connection : undefined;
    const project = await database.createProject({
      organizationId: connection.organizationId,
      name: "Linear session",
      slug: "linear-session",
      createdByUserId: "user-1",
    });
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "linear-session-config",
    });
    await database.activateProjectConfigurationRevision(project.id, revision.id, [
      {
        provider: "linear",
        connectionId: connection.id,
        resourceId: "linear-project",
        triggerName: "agent-session",
      },
    ]);
    const started = await database.acceptLinearEvent({
      linearOrganizationId: connection.linearOrganizationId,
      projectId: "linear-project",
      deliveryId: "linear-session-started",
      source: "linear.agent_session",
      payload: {},
      receivedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(started.status, "accepted");
    if (started.status !== "accepted") throw new Error("expected accepted session event");
    await database.createAcceptedLinearTriggerRun({
      organizationId: connection.organizationId,
      projectId: project.id,
      configurationRevisionId: revision.id,
      providerEventReceiptId: started.receiptId,
      configuredTriggerName: "agent-session",
      prompt: "Help",
      inputs: {},
      triggerContext: {},
      outputContext: {
        provider: "linear",
        linearOrganizationId: connection.linearOrganizationId,
        issueId: "issue-1",
        agentSessionId: "session-1",
        threadRootCommentId: null,
      },
      deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
      stepIds: ["work"],
      linearTrigger: {
        kind: "agent_session",
        externalId: "session-1",
        eventOccurredAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    const replacement = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "config-without-linear",
    });
    await database.activateProjectConfigurationRevision(project.id, replacement.id, []);

    const stopped = await database.acceptLinearEvent({
      linearOrganizationId: connection.linearOrganizationId,
      projectId: "linear-project",
      deliveryId: "linear-session-stopped",
      source: "linear.agent_session",
      payload: stopPayload("session-1"),
      receivedAt: new Date("2026-01-01T00:01:00.000Z"),
    });
    assert.equal(stopped.status, "accepted");
    if (stopped.status !== "accepted") throw new Error("expected accepted stop event");
    assert.deepEqual(
      stopped.events.map((event) => ({
        projectId: event.projectId,
        configurationRevisionId: event.configurationRevisionId,
      })),
      [{ projectId: project.id, configurationRevisionId: revision.id }],
    );

    await database.archiveProject(connection.organizationId, project.id, "user-1");
    const stoppedAfterArchive = await database.acceptLinearEvent({
      linearOrganizationId: connection.linearOrganizationId,
      projectId: "linear-project",
      deliveryId: "linear-session-stopped-after-archive",
      source: "linear.agent_session",
      payload: stopPayload("session-1"),
      receivedAt: new Date("2026-01-01T00:01:30.000Z"),
    });
    assert.equal(stoppedAfterArchive.status, "accepted");
    if (stoppedAfterArchive.status !== "accepted") {
      throw new Error("expected archived session stop event to be accepted");
    }
    assert.deepEqual(
      stoppedAfterArchive.events.map((event) => ({
        projectId: event.projectId,
        configurationRevisionId: event.configurationRevisionId,
      })),
      [{ projectId: project.id, configurationRevisionId: revision.id }],
    );

    const unrelated = await database.acceptLinearEvent({
      linearOrganizationId: connection.linearOrganizationId,
      projectId: "linear-project",
      deliveryId: "unrelated-linear-session-stopped",
      source: "linear.agent_session",
      payload: stopPayload("session-2"),
      receivedAt: new Date("2026-01-01T00:02:00.000Z"),
    });
    assert.equal(unrelated.status, "dropped");
    if (unrelated.status === "dropped") assert.equal(unrelated.reason, "no_project_route");
  });
});

function stopPayload(agentSessionId: string) {
  return {
    type: "agent_session",
    agentSession: { id: agentSessionId },
    agentActivity: { signal: "stop" },
  };
}
