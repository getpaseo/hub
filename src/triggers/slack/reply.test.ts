import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SlackBotClient } from "./client.js";
import { createSlackReplyExecutor } from "./reply.js";

describe("Slack reply output", () => {
  it.each([false, true])(
    "posts repeated replies into the same originating thread (already linked: %s)",
    async (alreadyLinked) => {
      const url = "https://hub.example/open/executions/00000000-0000-4000-8000-000000000001";
      const link = `<${url}|Open in Paseo>`;
      const content = alreadyLinked ? "Existing: " + link : "Done";
      const client = new RecordingSlackClient();
      const execute = createSlackReplyExecutor({ client });
      await execute({
        agentExecutionId: "execution-1",
        toolType: "slack.reply",
        args: { content },
        openInPaseoUrl: url,
        outputContext: {
          provider: "slack",
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          threadTs: "1700000000.000001",
          messageTs: "1700000000.000001",
        },
      });
      await execute({
        agentExecutionId: "execution-1",
        toolType: "slack.reply",
        args: { content: "Still working" },
        outputContext: {
          provider: "slack",
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          threadTs: "1700000000.000001",
          messageTs: "1700000000.000001",
        },
      });
      assert.deepEqual(client.messages, [
        {
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          threadTs: "1700000000.000001",
          content: alreadyLinked ? content : `${content}\n\n${link}`,
        },
        {
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          threadTs: "1700000000.000001",
          content: "Still working",
        },
      ]);
    },
  );

  it("delivers the original reply when a footer would be truncated", async () => {
    const client = new RecordingSlackClient();
    const content = "x".repeat(39_970);
    await createSlackReplyExecutor({ client })({
      agentExecutionId: "execution",
      toolType: "slack.reply",
      args: { content },
      openInPaseoUrl: "https://hub.example/open/executions/00000000-0000-4000-8000-000000000001",
      outputContext: { organizationId: "org-1", teamId: "T1", channelId: "C1", threadTs: "1.1" },
    });
    assert.equal(client.messages[0]?.content, content);
  });

  it("rejects invalid arguments before calling Slack", async () => {
    const client = new RecordingSlackClient();
    const execute = createSlackReplyExecutor({ client });
    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "slack.reply",
        args: { content: "" },
        outputContext: {
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          threadTs: "1.1",
        },
      }),
    );
    assert.deepEqual(client.messages, []);
  });

  it("fails closed for legacy output context without organization authority", async () => {
    const client = new RecordingSlackClient();
    const execute = createSlackReplyExecutor({ client });

    await assert.rejects(() =>
      execute({
        agentExecutionId: "legacy-execution",
        toolType: "slack.reply",
        args: { content: "Done" },
        outputContext: { teamId: "T1", channelId: "C1", threadTs: "1.1" },
      }),
    );
    assert.deepEqual(client.messages, []);
  });
});

class RecordingSlackClient implements SlackBotClient {
  messages: Array<{
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    content: string;
  }> = [];
  sendMessage(input: (typeof this.messages)[number]): Promise<void> {
    this.messages.push(input);
    return Promise.resolve();
  }
  addReaction(): Promise<void> {
    return Promise.resolve();
  }
  removeReaction(): Promise<void> {
    return Promise.resolve();
  }
}
