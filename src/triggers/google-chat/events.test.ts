import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseGoogleChatMentionEvent } from "./events.js";

describe("Google Chat event parsing", () => {
  it("accepts a direct message without an explicit @mention", () => {
    const parsed = parseGoogleChatMentionEvent(
      {
        type: "MESSAGE",
        eventTime: "2026-10-01T12:00:00.000Z",
        space: {
          name: "spaces/AAAABBBB",
          type: "DM",
          singleUserBotDm: true,
        },
        message: {
          name: "spaces/AAAABBBB/messages/msg-1",
          text: "investigate flaky test",
          createTime: "2026-10-01T12:00:00.000Z",
          thread: { name: "spaces/AAAABBBB/threads/thread-1" },
          sender: {
            name: "users/1001",
            displayName: "Alice Example",
            email: "alice@example.com",
            type: "HUMAN",
          },
        },
      },
      "example-project",
    );

    assert.equal(parsed.kind, "mention");
    if (parsed.kind !== "mention") return;
    assert.equal(parsed.event.spaceType, "dm");
    assert.equal(parsed.event.spaceName, "spaces/AAAABBBB");
    assert.equal(parsed.event.threadName, "spaces/AAAABBBB/threads/thread-1");
    assert.equal(parsed.event.argumentText, "investigate flaky test");
    assert.equal(parsed.event.author.email, "alice@example.com");
  });

  it("ignores space messages that do not mention the bot and accepts space @mentions", () => {
    const unmentioned = parseGoogleChatMentionEvent(
      {
        type: "MESSAGE",
        space: {
          name: "spaces/TEAMSPACE",
          spaceType: "SPACE",
          displayName: "Engineering",
        },
        message: {
          name: "spaces/TEAMSPACE/messages/msg-2",
          text: "general chatter without mentioning bot",
          createTime: "2026-10-01T12:05:00.000Z",
          sender: {
            name: "users/1001",
            displayName: "Alice Example",
            type: "HUMAN",
          },
        },
      },
      "example-project",
    );
    assert.equal(unmentioned.kind, "ignored");

    const mentioned = parseGoogleChatMentionEvent(
      {
        type: "MESSAGE",
        space: {
          name: "spaces/TEAMSPACE",
          spaceType: "SPACE",
          displayName: "Engineering",
        },
        message: {
          name: "spaces/TEAMSPACE/messages/msg-3",
          text: "@Paseo review PR #42",
          argumentText: " review PR #42",
          createTime: "2026-10-01T12:06:00.000Z",
          thread: { name: "spaces/TEAMSPACE/threads/thread-9" },
          annotations: [
            {
              type: "USER_MENTION",
              startIndex: 0,
              length: 6,
              userMention: {
                user: { name: "users/9999", displayName: "Paseo", type: "BOT" },
              },
            },
          ],
          sender: {
            name: "users/1001",
            displayName: "Alice Example",
            email: "alice@example.com",
            type: "HUMAN",
          },
        },
      },
      "example-project",
    );
    assert.equal(mentioned.kind, "mention");
    if (mentioned.kind !== "mention") return;
    assert.equal(mentioned.event.spaceType, "space");
    assert.equal(mentioned.event.spaceDisplayName, "Engineering");
    assert.equal(mentioned.event.argumentText, "review PR #42");
  });

  it("parses Google Workspace Add-on chat.messagePayload envelopes and ignores BOT senders", () => {
    const addon = parseGoogleChatMentionEvent(
      {
        chat: {
          eventTime: "2026-10-01T12:10:00.000Z",
          user: {
            name: "users/2002",
            displayName: "Bob Example",
            email: "bob@example.org",
            type: "HUMAN",
          },
          messagePayload: {
            space: {
              name: "spaces/ADDONSPACE",
              spaceType: "SPACE",
              displayName: "Platform",
            },
            message: {
              name: "spaces/ADDONSPACE/messages/msg-4",
              text: "@Paseo deploy staging",
              annotations: [
                {
                  type: "USER_MENTION",
                  startIndex: 0,
                  length: 6,
                  userMention: { user: { type: "BOT" } },
                },
              ],
            },
          },
        },
      },
      "example-project",
    );
    assert.equal(addon.kind, "mention");
    if (addon.kind !== "mention") return;
    assert.equal(addon.event.argumentText, "deploy staging");
    assert.equal(addon.event.author.id, "users/2002");

    const fromBot = parseGoogleChatMentionEvent(
      {
        type: "MESSAGE",
        space: { name: "spaces/AAAABBBB", type: "DM", singleUserBotDm: true },
        message: {
          name: "spaces/AAAABBBB/messages/msg-5",
          text: "automated bot message",
          createTime: "2026-10-01T12:11:00.000Z",
          sender: { name: "users/9999", displayName: "Paseo", type: "BOT" },
        },
      },
      "example-project",
    );
    assert.equal(fromBot.kind, "ignored");
  });
});
