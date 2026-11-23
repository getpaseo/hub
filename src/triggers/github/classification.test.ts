import assert from "node:assert/strict";
import { it } from "vitest";
import { classifyGitHubEvent } from "./classification.js";

it("classifies the ready transition and preserves its revision for the reviewer", () => {
  const classified = classifyGitHubEvent({
    id: "ready-delivery",
    type: "pull_request",
    repo: "owner/repo",
    repositoryId: 7,
    installationId: 42,
    createdAt: "2026-10-28T00:00:00.000Z",
    payload: {
      action: "ready_for_review",
      sender: { login: "maintainer" },
      pull_request: { number: 12, draft: false, head: { sha: "reviewed-head" } },
    },
  });
  assert.equal(classified.semanticEvent, "github.pull_request_ready_for_review");
  assert.deepEqual(classified.pullRequest, { draft: false, headSha: "reviewed-head" });
  assert.equal(classified.actor, "maintainer");
  assert.equal(classified.item?.number, 12);
});

it("classifies new commits on a pull request with the pushed head", () => {
  const classified = classifyGitHubEvent({
    id: "synchronize-delivery",
    type: "pull_request",
    repo: "owner/repo",
    repositoryId: 7,
    installationId: 42,
    createdAt: "2026-10-29T00:00:00.000Z",
    payload: {
      action: "synchronize",
      sender: { login: "maintainer" },
      pull_request: { number: 12, draft: false, head: { sha: "pushed-head" } },
    },
  });
  assert.equal(classified.semanticEvent, "github.pull_request_synchronized");
  assert.deepEqual(classified.pullRequest, { draft: false, headSha: "pushed-head" });
});

it.each([
  {
    type: "issue_comment",
    reports: "the comment",
    payload: {
      action: "created",
      sender: { login: "maintainer" },
      issue: { number: 12, user: { login: "reporter" }, author_association: "NONE" },
      comment: { id: 1, body: "hi", user: { login: "maintainer" }, author_association: "MEMBER" },
    },
    expected: "MEMBER",
  },
  {
    type: "pull_request_review",
    reports: "the review",
    payload: {
      action: "submitted",
      sender: { login: "maintainer" },
      pull_request: { number: 12, user: { login: "reporter" }, author_association: "NONE" },
      review: { body: "ok", user: { login: "maintainer" }, author_association: "COLLABORATOR" },
    },
    expected: "COLLABORATOR",
  },
  {
    type: "pull_request_review_comment",
    reports: "the review comment",
    payload: {
      action: "created",
      sender: { login: "maintainer" },
      pull_request: { number: 12, user: { login: "reporter" }, author_association: "NONE" },
      comment: { id: 2, body: "ok", user: { login: "maintainer" }, author_association: "OWNER" },
    },
    expected: "OWNER",
  },
  {
    type: "pull_request",
    reports: "the pull request its actor opened",
    payload: {
      action: "opened",
      sender: { login: "reporter" },
      pull_request: { number: 12, user: { login: "reporter" }, author_association: "CONTRIBUTOR" },
    },
    expected: "CONTRIBUTOR",
  },
  {
    type: "pull_request",
    reports: "nothing when the actor is not the author GitHub described",
    payload: {
      action: "synchronize",
      sender: { login: "maintainer" },
      pull_request: { number: 12, user: { login: "reporter" }, author_association: "MEMBER" },
    },
    expected: undefined,
  },
  {
    type: "push",
    reports: "nothing for a push",
    payload: { sender: { login: "maintainer" }, author_association: "OWNER" },
    expected: undefined,
  },
])("reads the actor's association from $reports", ({ type, payload, expected }) => {
  const classified = classifyGitHubEvent({
    id: "association-delivery",
    type,
    repo: "owner/repo",
    repositoryId: 7,
    installationId: 42,
    createdAt: "2026-11-21T00:00:00.000Z",
    payload,
  });
  assert.equal(classified.actorAssociation, expected);
});
