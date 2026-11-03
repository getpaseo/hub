import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { GoogleChatBotClient } from "./client.js";
import { createGoogleChatReplyExecutor } from "./reply.js";

class RecordingGoogleChatClient implements GoogleChatBotClient {
  readonly sent: Array<{ spaceName: string; threadName: string | null; text: string }> = [];

  sendMessage(input: {
    spaceName: string;
    threadName: string | null;
    text: string;
  }): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }

  readThreadMessages() {
    return Promise.resolve({ status: "loaded" as const, messages: [] });
  }

  verifySpacesAccess() {
    return Promise.resolve();
  }
}

describe("Google Chat reply output", () => {
  it("posts replies into the originating Google Chat space and thread", async () => {
    const client = new RecordingGoogleChatClient();
    const execute = createGoogleChatReplyExecutor({ client });

    await execute({
      agentExecutionId: "execution-1",
      toolType: "google-chat.reply",
      args: { content: "Investigating the failing test now." },
      outputContext: {
        provider: "google-chat",
        projectId: "example-project",
        spaceName: "spaces/AAAABBBB",
        threadName: "spaces/AAAABBBB/threads/thread-1",
        messageName: "spaces/AAAABBBB/messages/msg-1",
      },
    });

    assert.deepEqual(client.sent, [
      {
        spaceName: "spaces/AAAABBBB",
        threadName: "spaces/AAAABBBB/threads/thread-1",
        text: "Investigating the failing test now.",
      },
    ]);
  });

  it("rejects empty reply content and incomplete output context", async () => {
    const client = new RecordingGoogleChatClient();
    const execute = createGoogleChatReplyExecutor({ client });

    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "google-chat.reply",
        args: { content: "" },
        outputContext: {
          spaceName: "spaces/AAAABBBB",
          threadName: "spaces/AAAABBBB/threads/thread-1",
          messageName: "spaces/AAAABBBB/messages/msg-1",
        },
      }),
    );

    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "google-chat.reply",
        args: { content: "Done" },
        outputContext: {
          spaceName: "spaces/AAAABBBB",
        },
      }),
    );

    assert.deepEqual(client.sent, []);
  });
});
