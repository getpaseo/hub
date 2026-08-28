import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { LinearApiClient } from "../../providers/linear/client.js";
import { createLinearReplyExecutor } from "./reply.js";

describe("Linear reply output", () => {
  it.each([false, true])(
    "posts the workflow outcome onto its triggering issue (already linked: %s)",
    async (alreadyLinked) => {
      const url = "https://hub.example/open/executions/00000000-0000-4000-8000-000000000001";
      const link = `[Open in Paseo](${url})`;
      const content = alreadyLinked
        ? "Existing: " + link
        : "Draft PR: https://github.com/acme/repo/pull/42";
      const client = new RecordingLinearClient();
      const execute = createLinearReplyExecutor({ client });
      await execute({
        agentExecutionId: "execution-1",
        toolType: "linear.reply",
        args: { content },
        openInPaseoUrl: url,
        outputContext: {
          provider: "linear",
          linearOrganizationId: "linear-org",
          issueId: "issue-1",
          agentSessionId: null,
        },
      });
      assert.deepEqual(client.comments, [
        {
          linearOrganizationId: "linear-org",
          issueId: "issue-1",
          body: alreadyLinked ? content : `${content}\n\n${link}`,
        },
      ]);
    },
  );

  it("responds through a native Linear agent session", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Draft PR: https://github.com/acme/repo/pull/42" },
      outputContext: {
        provider: "linear",
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        agentSessionId: "session-1",
      },
    });

    assert.deepEqual(client.activities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: {
          type: "response",
          body: "Draft PR: https://github.com/acme/repo/pull/42",
        },
      },
    ]);
    assert.deepEqual(client.comments, []);
  });

  it("fails closed for an output context from another provider", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "linear.reply",
        args: { content: "Done" },
        outputContext: { provider: "slack", issueId: "issue-1" },
      }),
    );
    assert.deepEqual(client.comments, []);
  });
});

class RecordingLinearClient implements LinearApiClient {
  comments: Array<{ linearOrganizationId: string; issueId: string; body: string }> = [];
  activities: Parameters<LinearApiClient["createAgentActivity"]>[0][] = [];

  async readIssue(): Promise<undefined> {
    return undefined;
  }

  async readIssueComments() {
    return { comments: [], complete: true };
  }

  async readAgentSessionActivities() {
    return { activities: [], complete: true };
  }

  async createComment(input: (typeof this.comments)[number]): Promise<void> {
    this.comments.push(input);
  }

  async createAgentActivity(
    input: Parameters<LinearApiClient["createAgentActivity"]>[0],
  ): Promise<void> {
    this.activities.push(input);
  }
}
