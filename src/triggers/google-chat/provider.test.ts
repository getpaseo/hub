import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import {
  TEST_DAEMON_SLUG,
  createActiveProjectConfiguration,
} from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch, type ExternalTrigger } from "../index.js";
import type { GoogleChatBotClient, GoogleChatThreadReadResult } from "./client.js";
import type { NormalizedGoogleChatMentionEvent } from "./events.js";
import { createGoogleChatTriggerProvider } from "./provider.js";

class RecordingGoogleChatClient implements GoogleChatBotClient {
  readonly sent: Array<{ spaceName: string; threadName: string | null; text: string }> = [];
  threadResult: GoogleChatThreadReadResult = {
    status: "loaded",
    messages: [
      {
        id: "spaces/TEAMSPACE/messages/msg-0",
        spaceName: "spaces/TEAMSPACE",
        threadName: "spaces/TEAMSPACE/threads/thread-1",
        text: "Earlier thread context",
        author: {
          id: "users/1001",
          displayName: "Alice Example",
          email: "alice@example.com",
          bot: false,
        },
        createdAt: "2026-10-01T11:59:00.000Z",
      },
    ],
  };

  sendMessage(input: {
    spaceName: string;
    threadName: string | null;
    text: string;
  }): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }

  readThreadMessages(): Promise<GoogleChatThreadReadResult> {
    return Promise.resolve(this.threadResult);
  }

  verifySpacesAccess(): Promise<void> {
    return Promise.resolve();
  }
}

function googleChatConfiguration(overrides?: {
  channels?: string[];
  fromUsers?: string[];
  pattern?: string;
}) {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/repo" }],
    triggers: [
      {
        name: "chat-assistant",
        on: "google-chat.mention",
        max_runtime: "30m",
        filters: {
          from_users: overrides?.fromUsers ?? ["alice@example.com"],
          ...(overrides?.channels === undefined ? {} : { channels: overrides.channels }),
          ...(overrides?.pattern === undefined ? {} : { pattern: overrides.pattern }),
        },
        steps: [
          {
            id: "respond",
            environment: "runner",
            max_runtime: "15m",
            idle_timeout: "5m",
            agent: { provider: "codex", mode: "full-access" },
            prompt: [{ text: "Respond to {{ google_chat.trigger_message.body }}" }],
          },
        ],
      },
    ],
  };
}

function mentionPayload(
  overrides: Partial<NormalizedGoogleChatMentionEvent> = {},
): NormalizedGoogleChatMentionEvent {
  return {
    type: "mention",
    id: "spaces/TEAMSPACE/messages/msg-1",
    projectId: "example-project",
    spaceName: "spaces/TEAMSPACE",
    spaceDisplayName: "Engineering",
    spaceType: "space",
    threadName: "spaces/TEAMSPACE/threads/thread-1",
    messageName: "spaces/TEAMSPACE/messages/msg-1",
    text: "@Paseo deploy service",
    argumentText: "deploy service",
    author: {
      id: "users/1001",
      displayName: "Alice Example",
      email: "alice@example.com",
      bot: false,
    },
    createdAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

function externalTrigger(
  projectId: string,
  configurationRevisionId: string,
  payload: NormalizedGoogleChatMentionEvent,
): ExternalTrigger {
  return {
    providerEventReceiptId: "receipt-1",
    organizationId: "org-1",
    projectId,
    configurationRevisionId,
    source: "google-chat.mention",
    deliveryId: `google-chat-${payload.messageName}`,
    receivedAt: new Date("2026-10-01T12:00:00.000Z"),
    payload,
  };
}

describe("Google Chat trigger provider", () => {
  it("matches space, author, and pattern filters and hydrates deferred thread context", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      googleChatConfiguration({
        channels: ["TEAMSPACE"],
        fromUsers: ["alice@example.com"],
        pattern: "deploy",
      }),
      { organizationId: "org-1" },
    );
    const client = new RecordingGoogleChatClient();
    const provider = createGoogleChatTriggerProvider({
      configurationStoreForProject: () => store,
      client,
    });

    const rejectedWrongSpace = await provider.match(
      externalTrigger(project.id, revision.id, mentionPayload({ spaceName: "spaces/OTHERSPACE" })),
    );
    assert.equal(rejectedWrongSpace, "trigger_filters_rejected");

    const first = (
      await provider.match(externalTrigger(project.id, revision.id, mentionPayload()))
    )[0];
    if (!isAcceptedTriggerProviderMatch(first)) {
      throw new Error("expected accepted match");
    }
    assert.equal(first.conversation?.label, "Google Chat thread");
    assert.equal(
      first.conversation?.key,
      JSON.stringify(["google-chat", "example-project", "spaces/TEAMSPACE/threads/thread-1"]),
    );

    const hydrated = await provider.materializeContext!({
      executionId: "exec-1",
      organizationId: "org-1",
      projectId: project.id,
      providerEventReceiptId: "receipt-1",
      triggerContext: first.triggerContext,
    });
    assert.equal(hydrated.google_chat.thread.status, "available");
    assert.equal(hydrated.google_chat.thread.messages.length, 1);
    assert.equal(hydrated.google_chat.thread.messages[0]?.content, "Earlier thread context");
  });

  it("keys direct message conversations by space and posts billing failure notices in thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    try {
      const database = createMemoryDatabase();
      const { project, revision, store } = await createActiveProjectConfiguration(
        database,
        googleChatConfiguration({ fromUsers: ["*"] }),
        { organizationId: "org-1" },
      );
      const client = new RecordingGoogleChatClient();
      const provider = createGoogleChatTriggerProvider({
        configurationStoreForProject: () => store,
        client,
        billingUrlForOrganization: () =>
          Promise.resolve("https://hub.example.com/o/example-org/settings/billing"),
      });

      const first = (
        await provider.match(
          externalTrigger(
            project.id,
            revision.id,
            mentionPayload({
              spaceName: "spaces/DMSPACE",
              spaceType: "dm",
              threadName: "spaces/DMSPACE/threads/dm-thread-1",
            }),
          ),
        )
      )[0];
      if (!isAcceptedTriggerProviderMatch(first)) {
        throw new Error("expected accepted match");
      }
      assert.equal(first.conversation?.label, "Google Chat direct message");
      assert.equal(
        first.conversation?.key,
        JSON.stringify(["google-chat", "example-project", "spaces/DMSPACE"]),
      );

      await provider.onAgentExecutionFailed?.(
        first.triggerContext,
        first.outputContext,
        JSON.stringify({
          error: "entitlement_denied",
          entitlement: "executions.monthly",
          kind: "meter",
          limit: 50,
          current: 50,
        }),
      );
      assert.equal(client.sent.length, 1);
      assert.equal(client.sent[0]?.spaceName, "spaces/DMSPACE");
      assert.equal(client.sent[0]?.threadName, "spaces/DMSPACE/threads/dm-thread-1");
      assert.match(
        client.sent[0]?.text ?? "",
        /https:\/\/hub\.example\.com\/o\/example-org\/settings\/billing/u,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
