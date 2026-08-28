import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { normalizeLinearEvent } from "./events.js";

describe("Linear event normalization", () => {
  it("falls back to a nested comment user when the top-level actor is null", () => {
    const event = normalizeComment({ user: { id: "user-1", displayName: "Operator" } });

    assert.deepEqual(event?.actor, { id: "user-1", name: "Operator" });
  });

  it("falls back to a nested comment user ID when the top-level actor is null", () => {
    const event = normalizeComment({ userId: "user-1" });

    assert.deepEqual(event?.actor, { id: "user-1" });
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
