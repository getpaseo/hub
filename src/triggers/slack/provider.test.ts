import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import type { SlackBotClient } from "./client.js";
import { createSlackTriggerProvider } from "./provider.js";

describe("Slack Phase 1 trigger provider", () => {
  it("matches the literal step and preserves the message reply target", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const match = (await provider.match(external(project.id)))[0];

    assert.ok(match);
    assert.equal(match.stepId, "slack-step");
    assert.equal(match.prompt, "Handle the Slack mention.");
    assert.equal(match.configurationRevisionId, revision.id);
    assert.deepEqual(match.allowOutputs, [{ type: "slack.reply", max: 1 }]);
    assert.equal(match.outputContext.threadTs, "1700000000.000001");
    assert.equal(match.outputContext.messageTs, "1700000000.000001");
  });

  it("keeps provider reactions idempotent across the durable lifecycle hooks", async () => {
    const database = createMemoryDatabase();
    const { project, store } = await createActiveProjectConfiguration(database, configuration(), {
      organizationId: "org-1",
    });
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const match = (await provider.match(external(project.id)))[0];
    assert.ok(match);
    await provider.onAgentExecutionStarted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionCompleted?.(match.triggerContext, match.outputContext, {
      status: "succeeded",
    });
    assert.deepEqual(client.reactions, [
      "org-1:T1:remove:eyes",
      "org-1:T1:add:hourglass_flowing_sand",
      "org-1:T1:remove:hourglass_flowing_sand",
      "org-1:T1:add:white_check_mark",
    ]);
  });
});

function configuration() {
  return {
    environments: [{ name: "slack-runner", kind: "daemon", daemon: "main", cwd: "/repo" }],
    triggers: [
      {
        name: "slack-run",
        on: "slack.mention",
        max_runtime: "2h",
        filters: { workspace: "T1", channels: ["C1"], from_users: ["U1"] },
        steps: [
          {
            id: "slack-step",
            environment: "slack-runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "test", mode: "full-access" },
            prompt: [{ text: "Handle the Slack mention." }],
            allow_outputs: [{ type: "slack.reply" }],
          },
        ],
      },
    ],
  };
}

function external(projectId: string) {
  return {
    organizationId: "org-1",
    projectId,
    source: "slack.mention",
    deliveryId: "slack-delivery-1",
    receivedAt: new Date(),
    payload: {
      type: "mention",
      id: "Ev1",
      teamId: "T1",
      appId: "A1",
      channelId: "C1",
      messageTs: "1700000000.000001",
      threadTs: "1700000000.000001",
      eventTs: "1700000000.000001",
      eventTime: 1_700_000_001,
      content: "<@UBOT> deploy now",
      author: { id: "U1" },
      createdAt: new Date(1_700_000_000_000).toISOString(),
    },
  };
}

class RecordingSlackClient implements SlackBotClient {
  reactions: string[] = [];

  sendMessage(): Promise<void> {
    return Promise.resolve();
  }

  addReaction(input: { organizationId: string; teamId: string; name: string }): Promise<void> {
    this.reactions.push(`${input.organizationId}:${input.teamId}:add:${input.name}`);
    return Promise.resolve();
  }

  removeReaction(input: { organizationId: string; teamId: string; name: string }): Promise<void> {
    this.reactions.push(`${input.organizationId}:${input.teamId}:remove:${input.name}`);
    return Promise.resolve();
  }
}
