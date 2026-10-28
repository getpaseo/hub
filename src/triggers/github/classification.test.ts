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
