import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { normalizeLinearEvent } from "./events.js";

describe("Linear event normalization", () => {
  it("uses a comment's own timestamp as the causal history anchor", () => {
    const event = normalizeLinearEvent({
      action: "create",
      type: "Comment",
      organizationId: "linear-org",
      createdAt: "2026-01-02T00:00:05.000Z",
      webhookTimestamp: Date.parse("2026-01-02T00:00:10.000Z"),
      data: {
        id: "comment-1",
        issueId: "issue-1",
        body: "Please investigate",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    });

    assert.equal(event?.occurredAt, "2026-01-02T00:00:00.000Z");
  });

  it("does not use a delivery timestamp as a causal history anchor", () => {
    const event = normalizeLinearEvent({
      action: "create",
      type: "Comment",
      organizationId: "linear-org",
      webhookTimestamp: Date.parse("2026-01-02T00:00:10.000Z"),
      data: { id: "comment-1", issueId: "issue-1", body: "Please investigate" },
    });

    assert.equal(event?.occurredAt, undefined);
  });

  it("falls back to a nested comment user when the top-level actor is null", () => {
    const event = normalizeComment({ user: { id: "user-1", displayName: "Operator" } });

    assert.deepEqual(event?.actor, { id: "user-1", name: "Operator" });
  });

  it("falls back to a nested comment user ID when the top-level actor is null", () => {
    const event = normalizeComment({ userId: "user-1" });

    assert.deepEqual(event?.actor, { id: "user-1" });
  });

  it("preserves a comment's parent identity", () => {
    const reply = normalizeComment({ parent: { id: "comment-root" } });
    const root = normalizeComment({ parentId: null });

    assert.equal(reply?.type, "comment");
    assert.equal(reply?.type === "comment" ? reply.comment.parentId : undefined, "comment-root");
    assert.equal(root?.type === "comment" ? root.comment.parentId : undefined, null);
  });

  it("preserves explicit nulls in relation-expanded previous issue values", () => {
    const event = normalizeLinearEvent({
      action: "update",
      type: "Issue",
      organizationId: "linear-org",
      updatedFrom: { project: null, team: null, state: null, assignee: null },
      data: {
        id: "issue-1",
        title: "Newly scoped issue",
        description: null,
        project: { id: "project-1" },
        team: { id: "team-1" },
        state: { id: "state-1" },
        assignee: { id: "user-1" },
      },
    });

    assert.equal(event?.type, "issue");
    if (event?.type !== "issue") throw new Error("expected an issue event");
    assert.deepEqual(event.updatedFrom, {
      projectId: null,
      teamId: null,
      stateId: null,
      assigneeId: null,
    });
  });

  it("does not replace explicit null issue relations with hydrated values", () => {
    const event = normalizeLinearEvent(
      {
        action: "update",
        type: "Issue",
        organizationId: "linear-org",
        data: {
          id: "issue-1",
          title: "Projectless issue",
          project: null,
          team: null,
          state: null,
          assignee: null,
        },
      },
      undefined,
      {
        id: "issue-1",
        title: "Projectless issue",
        description: null,
        projectId: "later-project",
        teamId: "later-team",
        stateId: "later-state",
        assigneeId: "later-assignee",
        labelIds: [],
      },
    );

    assert.equal(event?.type, "issue");
    if (event?.type !== "issue") throw new Error("expected an issue event");
    assert.deepEqual(
      {
        projectId: event.issue.projectId,
        teamId: event.issue.teamId,
        stateId: event.issue.stateId,
        assigneeId: event.issue.assigneeId,
      },
      { projectId: null, teamId: null, stateId: null, assigneeId: null },
    );
  });

  it("normalizes a created agent session around Linear's canonical prompt context", () => {
    const event = normalizeLinearEvent(
      agentSessionEnvelope({ action: "created" }),
      "AgentSessionEvent",
      hydratedIssue(),
    );

    assert.equal(event?.type, "agent_session");
    if (event?.type !== "agent_session") throw new Error("expected an agent session event");
    assert.equal(event.action, "created");
    assert.equal(event.prompt, "<issue>Canonical Linear context</issue>");
    assert.equal(event.parserMessage, "@Paseo please draft a fix");
    assert.equal(event.actor?.id, "user-1");
    assert.equal(event.issue?.projectId, "project-1");
    assert.equal(event.issue?.teamId, "team-1");
    assert.equal(event.agentActivity, null);
  });

  it("normalizes a prompted agent session from the prompt activity", () => {
    const event = normalizeLinearEvent(
      agentSessionEnvelope({ action: "prompted" }),
      "AgentSessionEvent",
      hydratedIssue(),
    );

    assert.equal(event?.type, "agent_session");
    if (event?.type !== "agent_session") throw new Error("expected an agent session event");
    assert.equal(event.action, "prompted");
    assert.equal(event.prompt, "Please also add a regression test");
    assert.equal(event.parserMessage, "Please also add a regression test");
    assert.deepEqual(event.actor, { id: "user-2", name: "Reviewer" });
    assert.deepEqual(event.agentActivity, {
      id: "activity-2",
      type: "prompt",
      body: "Please also add a regression test",
      createdAt: "2026-01-02T00:01:00.000Z",
    });
    assert.equal(event.occurredAt, "2026-01-02T00:01:00.000Z");
  });

  it("ignores non-lifecycle agent session actions", () => {
    assert.equal(
      normalizeLinearEvent(
        { ...agentSessionEnvelope({ action: "created" }), action: "updated" },
        "AgentSessionEvent",
      ),
      undefined,
    );
  });
});

function normalizeComment(extraData: Record<string, unknown>) {
  return normalizeLinearEvent({
    action: "create",
    type: "Comment",
    organizationId: "linear-org",
    actor: null,
    data: {
      id: "comment-1",
      issueId: "issue-1",
      body: "Please investigate",
      ...extraData,
    },
  });
}

function hydratedIssue() {
  return {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Ship the feature",
    description: "Useful context",
    url: "https://linear.app/acme/issue/ENG-42/ship-the-feature",
    projectId: "project-1",
    teamId: "team-1",
    stateId: "ready",
    assigneeId: "app-user",
    labelIds: ["agent-ready"],
  };
}

function agentSessionEnvelope(input: { action: "created" | "prompted" }) {
  return {
    action: input.action,
    type: "AgentSessionEvent",
    organizationId: "linear-org",
    appUserId: "app-user",
    createdAt: "2026-01-02T00:00:00.000Z",
    webhookTimestamp: Date.parse("2026-01-02T00:01:01.000Z"),
    promptContext: "<issue>Canonical Linear context</issue>",
    agentSession: {
      id: "session-1",
      appUserId: "app-user",
      issueId: "issue-1",
      status: "pending",
      createdAt: "2026-01-02T00:00:00.000Z",
      creator: { id: "user-1", name: "Operator" },
      comment: {
        id: "comment-1",
        issueId: "issue-1",
        userId: "user-1",
        body: "@Paseo please draft a fix",
      },
      issue: {
        id: "issue-1",
        identifier: "ENG-42",
        title: "Ship the feature",
        description: "Useful context",
        url: "https://linear.app/acme/issue/ENG-42/ship-the-feature",
        teamId: "team-1",
        team: { id: "team-1", name: "Engineering", key: "ENG" },
      },
      url: "https://linear.app/acme/issue/ENG-42#agent-session-session-1",
    },
    ...(input.action === "prompted"
      ? {
          agentActivity: {
            id: "activity-2",
            agentSessionId: "session-1",
            createdAt: "2026-01-02T00:01:00.000Z",
            updatedAt: "2026-01-02T00:01:00.000Z",
            userId: "user-2",
            user: { id: "user-2", name: "Reviewer" },
            content: { type: "prompt", body: "Please also add a regression test" },
          },
        }
      : {}),
  };
}
