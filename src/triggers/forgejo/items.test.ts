import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { summarizeTrigger } from "../../projects/activity-summary.js";
import {
  deliveryByName,
  loadForgejoContractFixtures,
} from "../../providers/forgejo/fake-server.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch } from "../index.js";
import { dispatchForgejoClaimed } from "./dispatch.js";
import { createForgejoItemConsumer, createForgejoItemTriggerProvider } from "./items.js";
import type { ForgejoVerifiedDelivery } from "./webhook.js";

const CONNECTION = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "acme-forgejo",
  instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

describe("Forgejo item workflow consumer", () => {
  it("fans one opened issue out to every matching route", async () => {
    const enqueued: string[] = [];
    const consumer = createForgejoItemConsumer({
      enqueue: async (trigger) => {
        enqueued.push(`${trigger.projectId}:${trigger.source}`);
      },
      listTargets: async () => [target("project-a", "rev-1"), target("project-b", "rev-2")],
    });
    const observation = await dispatchForgejoClaimed({
      delivery: await verified("issues-opened"),
      receiptId: "receipt-issue",
      connection: CONNECTION,
      consumers: { workflow: consumer },
    });
    assert.equal(observation.workflow.status, "succeeded");
    assert.deepEqual(enqueued, [
      "project-a:forgejo.issue_created",
      "project-b:forgejo.issue_created",
    ]);
  });

  it("ignores push events and does not enqueue", async () => {
    let called = false;
    const consumer = createForgejoItemConsumer({
      enqueue: async () => {
        called = true;
      },
      listTargets: async () => {
        called = true;
        return [];
      },
    });
    const observation = await dispatchForgejoClaimed({
      delivery: await verified("push-default-branch"),
      receiptId: "receipt-push",
      connection: CONNECTION,
      consumers: { workflow: consumer },
    });
    assert.equal(observation.workflow.status, "succeeded");
    assert.equal(called, false);
  });
});

describe("Forgejo item trigger provider", () => {
  it("matches created issues and pull requests and reacts on the exact item", async () => {
    const posted: string[] = [];
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(database, {
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "forgejo-issue",
          on: "forgejo.issue_created",
          max_runtime: "2h",
          filters: { from_users: ["*"] },
          steps: [step()],
        },
      ],
    });
    const provider = createForgejoItemTriggerProvider({
      configurationStoreForProject: () => store,
      connectionFor: async () => CONNECTION,
      reactions: {
        create: (input) => {
          posted.push(`${input.subject.kind}:${String(input.subject.id)}:${input.content}`);
          return Promise.resolve();
        },
      },
    });
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "issues-opened");
    const matched = await provider.match({
      providerEventReceiptId: "receipt-1",
      organizationId: project.organizationId,
      projectId: project.id,
      configurationRevisionId: revision.id,
      source: "forgejo.issue_created",
      deliveryId: String(delivery.headers["x-forgejo-delivery"]),
      receivedAt: new Date("2026-08-30T12:00:00Z"),
      payload: {
        headers: {
          "x-forgejo-delivery": delivery.headers["x-forgejo-delivery"],
          "x-forgejo-event": delivery.event,
          "x-forgejo-event-type": delivery.eventType,
        },
        raw: delivery.raw,
      },
      connectionId: CONNECTION.id,
      resourceId: "1",
    });
    if (typeof matched === "string") throw new Error(matched);
    const accepted = matched[0];
    if (accepted === undefined || !isAcceptedTriggerProviderMatch(accepted)) {
      throw new Error("expected accepted item match");
    }
    assert.deepEqual(accepted.triggerContext.reactionSubject, { kind: "issue", id: 3 });
    await provider.onDispatchAccepted?.(accepted.triggerContext, accepted.outputContext);
    await provider.onAgentExecutionCompleted?.(accepted.triggerContext, accepted.outputContext, {
      status: "succeeded",
    });
    assert.deepEqual(posted, ["issue:3:eyes", "issue:3:+1"]);
    const summary = summarizeTrigger("forgejo.issues", {
      headers: {
        "x-forgejo-event": delivery.event,
        "x-forgejo-event-type": delivery.eventType,
      },
      raw: delivery.raw,
    });
    assert.equal(summary.provider, "forgejo");
    assert.equal(summary.externalUrl, "https://forgejo.example.test/t00org/t00repo/issues/3");
  });

  it("does not match an issue route against a pull-request created event", async () => {
    const { project, revision, store } = await createActiveProjectConfiguration(
      createMemoryDatabase(),
      {
        environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
        triggers: [
          {
            name: "forgejo-issue",
            on: "forgejo.issue_created",
            max_runtime: "2h",
            filters: { from_users: ["*"] },
            steps: [step()],
          },
        ],
      },
    );
    const provider = createForgejoItemTriggerProvider({
      configurationStoreForProject: () => store,
      connectionFor: async () => CONNECTION,
    });
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "pull-request-opened");
    const matched = await provider.match({
      providerEventReceiptId: "receipt-pr",
      organizationId: project.organizationId,
      projectId: project.id,
      configurationRevisionId: revision.id,
      source: "forgejo.pull_request_created",
      deliveryId: String(delivery.headers["x-forgejo-delivery"]),
      receivedAt: new Date("2026-08-30T12:00:00Z"),
      payload: {
        headers: {
          "x-forgejo-delivery": delivery.headers["x-forgejo-delivery"],
          "x-forgejo-event": delivery.event,
          "x-forgejo-event-type": delivery.eventType,
        },
        raw: delivery.raw,
      },
      connectionId: CONNECTION.id,
      resourceId: "1",
    });
    assert.equal(matched, "trigger_filters_rejected");
  });
});

function target(projectId: string, configurationRevisionId: string) {
  return {
    projectId,
    organizationId: "org-1",
    configurationRevisionId,
    connectionId: CONNECTION.id,
    resourceId: "1",
  };
}

function step() {
  return {
    id: "reply",
    environment: "runner",
    max_runtime: "1h",
    idle_timeout: "5m",
    agent: { provider: "opencode", mode: "default" },
    prompt: [{ text: "Handle it" }],
  };
}

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
