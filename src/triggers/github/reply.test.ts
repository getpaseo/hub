import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  createGitHubReplyExecutor,
  githubReplyAvailable,
  type GitHubReplyClient,
} from "./reply.js";

describe("GitHub reply output", () => {
  it.each([false, true])(
    "posts a comment to the originating issue or pull request (already linked: %s)",
    async (alreadyLinked) => {
      const url = "https://hub.example/open/executions/00000000-0000-4000-8000-000000000001";
      const link = `[Open in Paseo](${url})`;
      const content = alreadyLinked ? "Existing: " + link : "Shipped.";
      const comments: Parameters<GitHubReplyClient["createIssueComment"]>[0][] = [];
      const client: GitHubReplyClient = {
        async createIssueComment(comment) {
          comments.push(comment);
        },
      };
      const outputContext = {
        provider: "github",
        target: { installationId: 42, repository: "getpaseo/hub" },
        event: { github: { item: { number: 92 } } },
      };

      assert.equal(githubReplyAvailable(outputContext), true);
      await createGitHubReplyExecutor({ client })({
        agentExecutionId: "execution-1",
        toolType: "github.reply",
        args: { content },
        openInPaseoUrl: url,
        outputContext,
      });

      assert.deepEqual(comments, [
        {
          installationId: 42,
          owner: "getpaseo",
          repo: "hub",
          issueNumber: 92,
          body: alreadyLinked ? content : `${content}\n\n${link}`,
        },
      ]);
    },
  );

  it("does not advertise reply when the event has no conversation item", () => {
    assert.equal(
      githubReplyAvailable({
        provider: "github",
        target: { installationId: 42, repository: "getpaseo/hub" },
        event: { github: { item: null } },
      }),
      false,
    );
  });
});
