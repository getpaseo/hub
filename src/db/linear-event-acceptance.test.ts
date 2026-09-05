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
      payload: sessionPayload("session-1"),
      receivedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(started.status, "accepted");
    if (started.status !== "accepted") throw new Error("expected accepted session event");
    const delayed = await database.acceptLinearEvent({
      linearOrganizationId: connection.linearOrganizationId,
      projectId: "linear-project",
      deliveryId: "linear-session-delayed",
      source: "linear.agent_session",
      payload: sessionPayload("session-delayed"),
      receivedAt: new Date("2026-01-01T00:00:01.000Z"),
    });
    assert.equal(delayed.status, "accepted");
    const future = await database.acceptLinearEvent({
      linearOrganizationId: connection.linearOrganizationId,
      projectId: "linear-project",
      deliveryId: "linear-session-future",
      source: "linear.agent_session",
      payload: sessionPayload("session-future"),
      receivedAt: new Date("2026-01-01T00:05:00.000Z"),
    });
    assert.equal(future.status, "accepted");
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

    const stoppedBeforeRun = await database.acceptLinearEvent({
      linearOrganizationId: connection.linearOrganizationId,
      projectId: "linear-project",
      deliveryId: "linear-session-delayed-stop",
      source: "linear.agent_session",
      payload: stopPayload("session-delayed"),
      receivedAt: new Date("2026-01-01T00:00:30.000Z"),
    });
    assert.equal(stoppedBeforeRun.status, "accepted");
    if (stoppedBeforeRun.status !== "accepted") {
      throw new Error("expected delayed session stop event to be accepted");
    }
    assert.deepEqual(
      stoppedBeforeRun.events.map((event) => ({
        projectId: event.projectId,
        configurationRevisionId: event.configurationRevisionId,
      })),
      [{ projectId: project.id, configurationRevisionId: revision.id }],
    );

    const stoppedBeforeFuture = await database.acceptLinearEvent({
      linearOrganizationId: connection.linearOrganizationId,
      projectId: "linear-project",
      deliveryId: "linear-session-stop-before-future",
      source: "linear.agent_session",
      payload: stopPayload("session-future"),
      receivedAt: new Date("2026-01-01T00:04:00.000Z"),
    });
    assert.equal(stoppedBeforeFuture.status, "dropped");
    if (stoppedBeforeFuture.status === "dropped") {
      assert.equal(stoppedBeforeFuture.reason, "no_project_route");
    }

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

function sessionPayload(agentSessionId: string) {
  return {
    type: "agent_session",
    agentSession: { id: agentSessionId },
  };
}

function stopPayload(agentSessionId: string) {
  return {
    type: "agent_session",
    agentSession: { id: agentSessionId },
    agentActivity: { signal: "stop" },
  };
}
