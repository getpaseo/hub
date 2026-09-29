import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import type { CreateAcceptedTriggerRunInput } from "./types.js";

describe("trigger runs by Linear comment", () => {
  it("lists the runs any of the given Linear comments started within one project, newest first", async () => {
    const database = createMemoryDatabase();
    const earlier = (
      await database.createAcceptedTriggerRun(
        linearRun("project-1", "receipt-1", "comment-1", new Date(1_000)),
      )
    ).run;
    const later = (
      await database.createAcceptedTriggerRun(
        linearRun("project-1", "receipt-2", "comment-1", new Date(2_000)),
      )
    ).run;
    const other = (
      await database.createAcceptedTriggerRun(
        linearRun("project-1", "receipt-3", "comment-2", new Date(3_000)),
      )
    ).run;
    await database.createAcceptedTriggerRun(
      linearRun("project-1", "receipt-4", null, new Date(4_000)),
    );
    await database.createAcceptedTriggerRun(
      linearRun("project-2", "receipt-5", "comment-1", new Date(5_000)),
    );

    const ids = async (commentIds: readonly string[]) =>
      (await database.listTriggerRunsForLinearComments("project-1", commentIds)).map((r) => r.id);
    assert.deepEqual(await ids(["comment-1"]), [later.id, earlier.id]);
    assert.deepEqual(await ids(["comment-2", "comment-1"]), [other.id, later.id, earlier.id]);
    assert.deepEqual(await ids(["comment-3"]), []);
    assert.deepEqual(await ids([]), []);
  });
});

/** A run as the Linear trigger provider records it; a session run carries no comment. */
function linearRun(
  projectId: string,
  providerEventReceiptId: string,
  commentId: string | null,
  createdAt: Date,
): CreateAcceptedTriggerRunInput {
  return {
    organizationId: "org-1",
    projectId,
    configurationRevisionId: "revision-1",
    providerEventReceiptId,
    configuredTriggerName: commentId === null ? "agent-session" : "comment",
    prompt: "raw",
    inputs: {},
    triggerContext: {
      provider: "linear",
      event: {
        linear: {
          comment: commentId === null ? null : { id: commentId, body: "raw", parent_id: null },
        },
      },
    },
    outputContext: { provider: "linear" },
    deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
    stepIds: ["work"],
    createdAt,
  };
}
