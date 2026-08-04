import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import type { ExternalTrigger, TriggerProvider } from "../triggers/index.js";
import {
  createManualTriggerSource,
  dispatchManualTrigger,
  handleManualTriggerRequest,
} from "../triggers/manual/source.js";
import type { LaunchMachineIntent } from "./launch-machine-intent.js";
import { createDispatcher } from "./index.js";

describe("manual trigger to daemon dispatch", () => {
  it("drops provider events when no configured trigger matches", async () => {
    const manual = await ManualDaemonDispatch.start(noMatchingProvider());

    await manual.receive({
      organizationId: "org_1",
      projectId: "00000000-0000-4000-8000-000000000001",
      source: "discord.mention",
      deliveryId: "manual-discord-no-match",
      receivedAt: new Date("2026-07-09T12:00:00.000Z"),
      payload: { message: "@paseo ping" },
    });

    assert.equal(await manual.droppedReason("manual-discord-no-match"), "no_matching_trigger");
  });

  it("turns a synthetic manual event into a daemon launch intent", async () => {
    const manual = await ManualDaemonDispatch.start(matchingProvider());

    assert.equal(
      await manual.deliver({
        organizationId: "org_1",
        projectId: "00000000-0000-4000-8000-000000000001",
        source: "discord.mention",
        deliveryId: "manual-discord-1",
        payload: { message: "@paseo ping" },
      }),
      200,
    );
    assert.deepEqual(manual.launches(), [
      { environmentKind: "daemon", daemon: "hetzner-faro", configVersionId: "config-1" },
    ]);
  });

  it("replays the original durable plan after configuration changes", async () => {
    const database = createMemoryDatabase();
    let version = "config-v1";
    const provider: TriggerProvider = {
      name: "mutable",
      eventNames: ["slack.mention"],
      async match(trigger) {
        const names = version === "config-v1" ? ["first", "second"] : ["first", "third"];
        return names.map((triggerName) => versionedProviderMatch(trigger, triggerName, version));
      },
    };
    const batches: LaunchMachineIntent[][] = [];
    let fail = true;
    const dispatch = createDispatcher({
      database,
      providers: [provider],
      freezeDispatchPlan: true,
      async dispatchLaunchMachineIntents(intents) {
        batches.push([...intents]);
        if (fail) throw new Error("handoff interrupted");
      },
    });
    const persisted = await database.insertTrigger({
      organizationId: "org_1",
      projectId: "00000000-0000-4000-8000-000000000001",
      deliveryId: "slack-Ev-frozen",
      source: "slack.mention",
      payload: { message: "@paseo ping" },
      receivedAt: new Date("2026-07-09T12:00:00.000Z"),
    });
    const trigger = {
      triggerId: persisted.trigger.id,
      organizationId: "org_1",
      projectId: "00000000-0000-4000-8000-000000000001",
      deliveryId: persisted.trigger.deliveryId,
      source: persisted.trigger.source,
      payload: persisted.trigger.payload,
      receivedAt: persisted.trigger.receivedAt,
      connectionId: null,
      resourceId: null,
    };

    await assert.rejects(dispatch(trigger), /handoff interrupted/);
    version = "config-v2";
    fail = false;
    await dispatch(trigger);

    assert.deepEqual(batches.map(planIdentity), [
      [
        ["first", "config-v1"],
        ["second", "config-v1"],
      ],
      [
        ["first", "config-v1"],
        ["second", "config-v1"],
      ],
    ]);
  });
});

class ManualDaemonDispatch {
  private readonly intents: LaunchMachineIntent[] = [];
  private readonly source;

  private constructor(private readonly database: Database) {
    this.source = createManualTriggerSource(database);
  }

  static async start(provider: TriggerProvider): Promise<ManualDaemonDispatch> {
    const manual = new ManualDaemonDispatch(createMemoryDatabase());
    const dispatch = createDispatcher({
      database: manual.database,
      providers: [provider],
      configurationRevisionId: "config-1",
      dispatchLaunchMachineIntent: async (intent) => {
        manual.intents.push(intent);
      },
    });
    await manual.source.start(dispatch);
    return manual;
  }

  receive(trigger: ExternalTrigger): Promise<unknown> {
    return dispatchManualTrigger(this.source, trigger);
  }

  async deliver(delivery: {
    organizationId: string;
    projectId: string;
    source: string;
    deliveryId: string;
    payload: unknown;
  }): Promise<number> {
    const response = await handleManualTriggerRequest(
      new Request("http://localhost/test/trigger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(delivery),
      }),
      this.source,
      "trigger",
    );
    return response.status;
  }

  async droppedReason(deliveryId: string): Promise<string | null | undefined> {
    return (await this.database.findTriggerByDeliveryId(deliveryId, "org_1"))?.droppedReason;
  }

  launches() {
    return this.intents.map((intent) => ({
      environmentKind: intent.environment.kind,
      daemon: intent.environment.kind === "daemon" ? intent.environment.authoredSlug : undefined,
      configVersionId: intent.configurationRevisionId,
    }));
  }
}

function noMatchingProvider(): TriggerProvider {
  return {
    name: "manual-discord",
    eventNames: ["discord.mention"],
    async match() {
      return [];
    },
  };
}

function matchingProvider(): TriggerProvider {
  return {
    name: "manual-discord",
    eventNames: ["discord.mention"],
    async match(trigger) {
      return [
        {
          triggerName: "discord-ping",
          environmentName: "hetzner-faro",
          environment: {
            kind: "daemon",
            daemonId: "daemon-1",
            authoredSlug: "hetzner-faro",
            cwd: "/home/moboudra/dev/faro",
          },
          prompt: `Reply to ${JSON.stringify(trigger.payload)}`,
          agent: { provider: "opencode", mode: "opencode/big-pickle" },
          allowOutputs: [{ type: "discord.reply" }],
          autoArchive: false,
          triggerContext: trigger.payload,
          outputContext: { channelId: "channel-1" },
          hubConfig: { triggers: [{ name: "discord-ping" }] },
        },
      ];
    },
  };
}

function matchingProviderMatch(trigger: ExternalTrigger) {
  return {
    triggerName: "discord-ping",
    environmentName: "hetzner-faro",
    environment: {
      kind: "daemon" as const,
      daemonId: "daemon-1",
      authoredSlug: "hetzner-faro",
      cwd: "/home/moboudra/dev/faro",
    },
    prompt: `Reply to ${JSON.stringify(trigger.payload)}`,
    agent: { provider: "opencode", mode: "opencode/big-pickle" },
    allowOutputs: [{ type: "discord.reply" as const }],
    autoArchive: false,
    triggerContext: trigger.payload,
    outputContext: { channelId: "channel-1" },
    hubConfig: { triggers: [{ name: "discord-ping" }] },
  };
}

function versionedProviderMatch(
  trigger: ExternalTrigger,
  triggerName: string,
  configurationRevisionId: string,
) {
  return Object.assign(matchingProviderMatch(trigger), { triggerName, configurationRevisionId });
}

function planIdentity(batch: readonly LaunchMachineIntent[]) {
  return batch.map(intentIdentity);
}

function intentIdentity(intent: LaunchMachineIntent) {
  return [intent.triggerName, intent.configurationRevisionId];
}
