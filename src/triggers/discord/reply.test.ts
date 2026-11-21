import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { MemoryDiscordBotClient } from "./memory-bot.js";
import { createDiscordReplyExecutor } from "./reply.js";

describe("Discord reply executor", () => {
  it.each([false, true])(
    "sends repeated replies through the conversation reply capability (already linked: %s)",
    async (alreadyLinked) => {
      const url = "https://hub.example/open/executions/00000000-0000-4000-8000-000000000001";
      const link = `[Open in Paseo](${url})`;
      const content = alreadyLinked ? "Existing: " + link : "hello world";
      const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
      const executor = createDiscordReplyExecutor({ bot });

      await executor({
        agentExecutionId: "exec-1",
        toolType: "discord.reply",
        args: { content },
        openInPaseoUrl: url,
        outputContext: { channelId: "200", threadId: null, messageId: "300" },
      });
      await executor({
        agentExecutionId: "exec-1",
        toolType: "discord.reply",
        args: { content: "second reply" },
        outputContext: { channelId: "200", threadId: null, messageId: "300" },
      });

      assert.deepEqual(bot.messages, [
        {
          channelId: "200",
          threadId: null,
          messageId: "300",
          content: alreadyLinked ? content : `${content}\n\n${link}`,
        },
        {
          channelId: "200",
          threadId: null,
          messageId: "300",
          content: "second reply",
        },
      ]);
    },
  );

  it("delivers a reply that already fills Discord's message limit", async () => {
    const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
    const content = "x".repeat(2000);
    await createDiscordReplyExecutor({ bot })({
      agentExecutionId: "exec-1",
      toolType: "discord.reply",
      args: { content },
      openInPaseoUrl: "https://hub.example/open/executions/00000000-0000-4000-8000-000000000001",
      outputContext: { channelId: "200", messageId: "300" },
    });
    assert.equal(bot.messages[0]?.content, content);
  });

  it("routes the reply to the thread when output context has a threadId", async () => {
    const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
    const executor = createDiscordReplyExecutor({ bot });

    await executor({
      agentExecutionId: "exec-2",
      toolType: "discord.reply",
      args: { content: "thread reply" },
      outputContext: { channelId: "200", threadId: "207", messageId: "300" },
    });

    assert.deepEqual(bot.messages, [
      {
        channelId: "200",
        threadId: "207",
        messageId: "300",
        content: "thread reply",
      },
    ]);
  });

  it("treats a missing threadId as no thread", async () => {
    const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
    const executor = createDiscordReplyExecutor({ bot });

    await executor({
      agentExecutionId: "exec-3",
      toolType: "discord.reply",
      args: { content: "no thread" },
      outputContext: { channelId: "200", messageId: "300" },
    });

    assert.deepEqual(bot.messages, [
      { channelId: "200", threadId: null, messageId: "300", content: "no thread" },
    ]);
  });

  it("rejects when args is missing the content field", async () => {
    const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
    const executor = createDiscordReplyExecutor({ bot });

    await assert.rejects(() =>
      executor({
        agentExecutionId: "exec-4",
        toolType: "discord.reply",
        args: {},
        outputContext: { channelId: "200", threadId: null },
      }),
    );
    assert.equal(bot.messages.length, 0);
  });

  it("rejects when outputContext is missing channelId", async () => {
    const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
    const executor = createDiscordReplyExecutor({ bot });

    await assert.rejects(() =>
      executor({
        agentExecutionId: "exec-5",
        toolType: "discord.reply",
        args: { content: "no channel" },
        outputContext: {},
      }),
    );
    assert.equal(bot.messages.length, 0);
  });

  it("rejects invalid Discord snowflakes in reply output context", async () => {
    const invalid = [
      { channelId: "0", threadId: null, messageId: "300" },
      { channelId: "-200", threadId: null, messageId: "300" },
      { channelId: "abc", threadId: null, messageId: "300" },
      { channelId: "200", threadId: "0", messageId: "300" },
      { channelId: "200", threadId: "-207", messageId: "300" },
      { channelId: "200", threadId: "thread", messageId: "300" },
      { channelId: "200", threadId: null, messageId: "0" },
      { channelId: "200", threadId: null, messageId: "-300" },
      { channelId: "200", threadId: null, messageId: "message" },
    ];

    for (const outputContext of invalid) {
      const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
      const executor = createDiscordReplyExecutor({ bot });
      await assert.rejects(() =>
        executor({
          agentExecutionId: "exec-invalid",
          toolType: "discord.reply",
          args: { content: "invalid id" },
          outputContext,
        }),
      );
      assert.equal(bot.messages.length, 0);
    }
  });
});
