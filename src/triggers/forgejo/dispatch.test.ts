import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  deliveryByName,
  loadForgejoContractFixtures,
} from "../../providers/forgejo/fake-server.js";
import { isRecord } from "../../providers/forgejo/contract-test-read.js";
import { dispatchForgejoClaimed } from "./dispatch.js";
import type { ForgejoVerifiedDelivery } from "./webhook.js";

const CONNECTION = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "acme-forgejo",
  instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

describe("Forgejo dual dispatch", () => {
  it("notifies workflow and config-sync independently for a default-branch push", async () => {
    const delivery = await verified("push-default-branch");
    const order: string[] = [];
    const observation = await dispatchForgejoClaimed({
      delivery,
      receiptId: "receipt-1",
      connection: CONNECTION,
      consumers: {
        workflow: {
          consume: async ({ event }) => {
            order.push("workflow");
            assert.equal(event.identity.eventId.length > 0, true);
            assert.equal(event.defaultBranchPush, true);
          },
        },
        configSync: {
          consume: async ({ event }) => {
            order.push("configSync");
            assert.equal(event.identity.eventId.length > 0, true);
            assert.equal(event.context.actor.login, "t00admin");
          },
        },
        hydration: {
          consume: async () => {
            throw new Error("hydration must not run for a complete push");
          },
        },
      },
    });
    assert.equal(observation.workflow.status, "succeeded");
    assert.equal(observation.configSync.status, "succeeded");
    assert.equal(observation.hydration.status, "skipped");
    assert.deepEqual(new Set(order), new Set(["workflow", "configSync"]));
    if (observation.result.kind !== "event") throw new Error("expected event");
    assert.equal(observation.result.event.rawFamily, "forgejo.push");
  });

  it("does not hide a config-sync failure behind a successful workflow consumer", async () => {
    const delivery = await verified("push-default-branch");
    const observation = await dispatchForgejoClaimed({
      delivery,
      receiptId: "receipt-2",
      connection: CONNECTION,
      consumers: {
        workflow: { consume: async () => undefined },
        configSync: {
          consume: async () => {
            throw new Error("sync_failed");
          },
        },
      },
    });
    assert.equal(observation.workflow.status, "succeeded");
    assert.equal(observation.configSync.status, "failed");
    assert.equal(observation.configSync.error, "sync_failed");
  });

  it("does not hide a workflow failure behind a successful config-sync consumer", async () => {
    const delivery = await verified("push-default-branch");
    const observation = await dispatchForgejoClaimed({
      delivery,
      receiptId: "receipt-3",
      connection: CONNECTION,
      consumers: {
        workflow: {
          consume: async () => {
            throw new Error("workflow_failed");
          },
        },
        configSync: { consume: async () => undefined },
      },
    });
    assert.equal(observation.workflow.status, "failed");
    assert.equal(observation.configSync.status, "succeeded");
  });

  it("sends incomplete label and review deliveries only to hydration", async () => {
    for (const name of [
      "issue-label-updated",
      "pull-request-label-updated",
      "pull-request-review-submitted",
    ]) {
      const observation = await dispatchForgejoClaimed({
        delivery: await verified(name),
        receiptId: `receipt-${name}`,
        connection: CONNECTION,
        consumers: {
          workflow: {
            consume: async () => {
              throw new Error("workflow must not run");
            },
          },
          configSync: {
            consume: async () => {
              throw new Error("config-sync must not run");
            },
          },
          hydration: {
            consume: async ({ signal }) => {
              assert.equal(signal.type.startsWith("incomplete_"), true);
            },
          },
        },
      });
      assert.equal(observation.hydration.status, "succeeded", name);
      assert.equal(observation.workflow.status, "skipped", name);
      assert.equal(observation.configSync.status, "skipped", name);
    }
  });

  it("does not notify config-sync for a non-default-branch push", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const source = deliveryByName(fixtures, "push-any");
    const parsed: unknown = JSON.parse(source.raw);
    assert.equal(isRecord(parsed), true);
    if (!isRecord(parsed)) throw new Error("push payload");
    parsed["ref"] = "refs/heads/topic";
    const raw = new TextEncoder().encode(JSON.stringify(parsed));
    const observation = await dispatchForgejoClaimed({
      delivery: {
        connectionId: CONNECTION.id,
        organizationId: "org-1",
        repositoryId: 1,
        deliveryId: String(source.headers["x-forgejo-delivery"]),
        event: source.event,
        eventType: source.eventType,
        signatureHash: "aa".repeat(32),
        rawBody: raw,
        receivedAt: new Date("2026-08-30T12:00:00Z"),
      },
      receiptId: "receipt-topic",
      connection: CONNECTION,
      consumers: {
        workflow: { consume: async () => undefined },
        configSync: {
          consume: async () => {
            throw new Error("config-sync must not run");
          },
        },
      },
    });
    assert.equal(observation.workflow.status, "succeeded");
    assert.equal(observation.configSync.status, "skipped");
  });
});

async function verified(name: string): Promise<ForgejoVerifiedDelivery> {
  const fixtures = await loadForgejoContractFixtures();
  const delivery = deliveryByName(fixtures, name);
  return {
    connectionId: CONNECTION.id,
    organizationId: "org-1",
    repositoryId: 1,
    deliveryId: String(delivery.headers["x-forgejo-delivery"]),
    event: delivery.event,
    eventType: delivery.eventType,
    signatureHash: "aa".repeat(32),
    rawBody: new TextEncoder().encode(delivery.raw),
    receivedAt: new Date("2026-08-30T12:00:00Z"),
  };
}
