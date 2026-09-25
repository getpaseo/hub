import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createForgejoReplyExecutor, forgejoReplyAvailable } from "./reply.js";

const CONNECTION_ID = "11111111-2222-4333-8444-555555555555";
const CREDENTIALS = { instanceBaseUrl: "https://git.example.test", accessToken: "tok" };

describe("Forgejo reply output", () => {
  it("posts a comment to the originating issue or pull request", async () => {
    const createIssueComment = vi.fn(() => Promise.resolve({ id: 7 }));
    const outputContext = {
      provider: "forgejo",
      connectionId: CONNECTION_ID,
      repository: "acme/widgets",
      issueNumber: 42,
    };

    assert.equal(forgejoReplyAvailable(outputContext), true);
    await createForgejoReplyExecutor({
      client: replyClient(createIssueComment),
      credentialsForConnection: () => Promise.resolve(CREDENTIALS),
    })({
      agentExecutionId: "execution-1",
      toolType: "forgejo.reply",
      args: { content: "Mostly harmless." },
      outputContext,
    });

    assert.deepEqual(createIssueComment.mock.calls, [
      [
        {
          credentials: CREDENTIALS,
          owner: "acme",
          repo: "widgets",
          issueNumber: 42,
          body: "Mostly harmless.",
        },
      ],
    ]);
  });

  // A push names no issue, so the tool must hide instead of being offered and then throwing.
  it("does not advertise reply when the delivery has nothing to comment on", () => {
    assert.equal(
      forgejoReplyAvailable({
        provider: "forgejo",
        connectionId: CONNECTION_ID,
        repository: "acme/widgets",
        issueNumber: null,
      }),
      false,
    );
  });

  it("does not advertise reply for another provider's context", () => {
    assert.equal(
      forgejoReplyAvailable({
        provider: "github",
        connectionId: CONNECTION_ID,
        repository: "acme/widgets",
        issueNumber: 42,
      }),
      false,
    );
  });
});

function replyClient(createIssueComment: () => Promise<{ id: number }>) {
  return {
    createIssueComment,
    readViewer: () => Promise.reject(new Error("not used here")),
    readVersion: () => Promise.reject(new Error("not used here")),
    getRepository: () => Promise.reject(new Error("not used here")),
    listIssueTimeline: () => Promise.reject(new Error("not used here")),
    listPullReviews: () => Promise.reject(new Error("not used here")),
    listPullReviewComments: () => Promise.reject(new Error("not used here")),
    listMyOrgs: () => Promise.reject(new Error("not used here")),
    listHooks: () => Promise.reject(new Error("not used here")),
    createHook: () => Promise.reject(new Error("not used here")),
    deleteHook: () => Promise.reject(new Error("not used here")),
    createReaction: () => Promise.reject(new Error("not used here")),
    deleteReaction: () => Promise.reject(new Error("not used here")),
  };
}
