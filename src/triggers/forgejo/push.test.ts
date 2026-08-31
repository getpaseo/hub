import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  deliveryByName,
  loadForgejoContractFixtures,
} from "../../providers/forgejo/fake-server.js";
import { dispatchForgejoClaimed } from "./dispatch.js";
import { createForgejoPushConsumer, forgejoPushHasReactionSubject } from "./push.js";
import type { ForgejoVerifiedDelivery } from "./webhook.js";

const CONNECTION = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "acme-forgejo",
  instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

describe("Forgejo push workflow consumer", () => {
  it("fans one push out to every matching route and never emits a reaction subject", async () => {
    const enqueued: string[] = [];
    const consumer = createForgejoPushConsumer({
      enqueue: async (trigger) => {
        enqueued.push(`${trigger.projectId}:${trigger.source}`);
        assert.equal(trigger.source, "forgejo.push");
        assert.equal(typeof trigger.payload === "object" && trigger.payload !== null, true);
      },
      listTargets: async () => [
        {
          projectId: "project-a",
          organizationId: "org-1",
          configurationRevisionId: "rev-1",
          connectionId: CONNECTION.id,
          resourceId: "1",
        },
        {
          projectId: "project-b",
          organizationId: "org-1",
          configurationRevisionId: "rev-2",
          connectionId: CONNECTION.id,
          resourceId: "1",
        },
      ],
    });
    const observation = await dispatchForgejoClaimed({
      delivery: await verified("push-default-branch"),
      receiptId: "receipt-push",
      connection: CONNECTION,
      consumers: { workflow: consumer },
    });
    assert.equal(observation.workflow.status, "succeeded");
    assert.deepEqual(enqueued, ["project-a:forgejo.push", "project-b:forgejo.push"]);
    assert.equal(forgejoPushHasReactionSubject(), false);
  });

  it("ignores non-push complete events and does not enqueue", async () => {
    let called = false;
    const consumer = createForgejoPushConsumer({
      enqueue: async () => {
        called = true;
      },
      listTargets: async () => {
        called = true;
        return [];
      },
    });
    const observation = await dispatchForgejoClaimed({
      delivery: await verified("issues-opened"),
      receiptId: "receipt-issue",
      connection: CONNECTION,
      consumers: { workflow: consumer },
    });
    assert.equal(observation.workflow.status, "succeeded");
    assert.equal(called, false);
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
