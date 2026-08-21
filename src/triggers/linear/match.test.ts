import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import type { NormalizedLinearCommentEvent, NormalizedLinearIssueEvent } from "./events.js";
import { matchLinearTriggers } from "./match.js";

describe("Linear trigger matching", () => {
  it("starts a project scout exactly when an issue enters its eligible scope", () => {
    const config = configuration();
    const entered = issue({ action: "update", updatedFrom: { stateId: "backlog" } });
    assert.deepEqual(
      matchLinearTriggers(config, entered).map((match) => match.trigger.name),
      ["scout"],
    );

    const alreadyEligible = issue({ action: "update", updatedFrom: { stateId: "ready" } });
    assert.equal(matchLinearTriggers(config, alreadyEligible).length, 0);

    const irrelevantEdit = issue({ action: "update", updatedFrom: {} });
    assert.equal(matchLinearTriggers(config, irrelevantEdit).length, 0);

    const excluded = issue({ action: "create", labelIds: ["no-paseo"] });
    assert.equal(matchLinearTriggers(config, excluded).length, 0);
  });

  it("keeps assignment and comment triggers actor-allowlisted", () => {
    const config = configuration();
    const assigned = issue({ action: "update", updatedFrom: { assigneeId: null } });
    assert.deepEqual(
      matchLinearTriggers(config, assigned).map((match) => match.trigger.name),
      ["assignment"],
    );
    assert.equal(
      matchLinearTriggers(config, { ...assigned, actor: { id: "untrusted" } }).length,
      0,
    );
    assert.equal(
      matchLinearTriggers(config, {
        ...assigned,
        actor: { id: "untrusted", name: "operator" },
      }).length,
      0,
    );
    assert.equal(
      matchLinearTriggers(config, {
        ...assigned,
        issue: { ...assigned.issue, assigneeId: null },
      }).length,
      0,
    );

    const comment = commentEvent();
    assert.deepEqual(
      matchLinearTriggers(config, comment).map((match) => match.trigger.name),
      ["comment"],
    );
    assert.equal(
      matchLinearTriggers(config, { ...comment, comment: { ...comment.comment, body: "hello" } })
        .length,
      0,
    );
  });
});

function configuration() {
  const base = {
    id: "work",
    environment: "runner",
    max_runtime: "1h",
    idle_timeout: "5m",
    agent: { provider: "codex" },
    prompt: [{ text: "Work from ${{ paseo.context }}" }],
  };
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "scout",
        on: "linear.issue_entered_scope",
        max_runtime: "2h",
        filters: {
          project: "project-1",
          states: ["ready"],
          exclude_labels: ["no-paseo"],
        },
        steps: [base],
      },
      {
        name: "assignment",
        on: "linear.issue_assigned",
        max_runtime: "2h",
        filters: { project: "project-1", from_users: ["operator"] },
        steps: [base],
      },
      {
        name: "comment",
        on: "linear.comment_created",
        max_runtime: "2h",
        filters: { project: "project-1", from_users: ["operator"], contains: "@paseo" },
        steps: [base],
      },
    ],
  });
}

function issue(
  overrides: Partial<NormalizedLinearIssueEvent> & {
    labelIds?: string[];
  } = {},
): NormalizedLinearIssueEvent {
  const { labelIds, ...event } = overrides;
  return {
    type: "issue",
    action: "create",
    id: "issue-1",
    organizationId: "linear-org",
    actor: { id: "operator" },
    issue: {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Ship the feature",
      description: "Useful context",
      projectId: "project-1",
      stateId: "ready",
      assigneeId: "user-1",
      labelIds: labelIds ?? [],
    },
    updatedFrom: {},
    ...event,
  };
}

function commentEvent(): NormalizedLinearCommentEvent {
  const event = issue();
  return {
    type: "comment",
    action: "create",
    id: "comment-1",
    organizationId: event.organizationId,
    actor: event.actor,
    comment: { id: "comment-1", issueId: event.issue.id, body: "@paseo please investigate" },
    issue: event.issue,
  };
}
