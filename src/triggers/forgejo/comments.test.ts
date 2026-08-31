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
import { createForgejoCommentConsumer, createForgejoCommentTriggerProvider } from "./comments.js";
import type { ForgejoVerifiedDelivery } from "./webhook.js";

const CONNECTION = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "acme-forgejo",
  instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

describe("Forgejo comment workflow consumer", () => {
  it("fans one issue comment out to every matching route", async () => {
    const enqueued: string[] = [];
    const consumer = createForgejoCommentConsumer({
      enqueue: async (trigger) => {
        enqueued.push(`${trigger.projectId}:${trigger.source}`);
      },
      listTargets: async () => [target("project-a", "rev-1"), target("project-b", "rev-2")],
    });
    const observation = await dispatchForgejoClaimed({
      delivery: await verified("issue-comment-created"),
      receiptId: "receipt-comment",
      connection: CONNECTION,
      consumers: { workflow: consumer },
    });
    assert.equal(observation.workflow.status, "succeeded");
    assert.deepEqual(enqueued, [
      "project-a:forgejo.issue_comment_created",
      "project-b:forgejo.issue_comment_created",
    ]);
  });

  it("ignores opened issues and does not enqueue", async () => {
    let called = false;
    const consumer = createForgejoCommentConsumer({
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

describe("Forgejo comment trigger provider", () => {
  it("matches issue comments and reacts on the exact comment, not the parent item", async () => {
    const posted: string[] = [];
    const { project, revision, store } = await createActiveProjectConfiguration(
      createMemoryDatabase(),
      routeConfig("forgejo.issue_comment_created"),
    );
    const provider = createForgejoCommentTriggerProvider({
      configurationStoreForProject: () => store,
      connectionFor: async () => CONNECTION,
      reactions: {
        create: (input) => {
          posted.push(`${input.subject.kind}:${String(input.subject.id)}:${input.content}`);
          return Promise.resolve();
        },
      },
    });
    const accepted = await matchNamed(provider, project, revision, "issue-comment-created");
    assert.deepEqual(accepted.triggerContext.reactionSubject, { kind: "comment", id: 2 });
    await provider.onDispatchAccepted?.(accepted.triggerContext, accepted.outputContext);
    await provider.onAgentExecutionFailed?.(
      accepted.triggerContext,
      accepted.outputContext,
      "failed",
    );
    assert.deepEqual(posted, ["comment:2:eyes", "comment:2:-1"]);
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "issue-comment-created");
    const summary = summarizeTrigger("forgejo.issue_comment", {
      headers: {
        "x-forgejo-event": delivery.event,
        "x-forgejo-event-type": delivery.eventType,
      },
      raw: delivery.raw,
    });
    assert.equal(summary.provider, "forgejo");
    assert.equal(
      summary.externalUrl,
      "https://forgejo.example.test/t00org/t00repo/issues/3#issuecomment-2",
    );
  });

  it("matches pull-request comments as a distinct semantic family", async () => {
    const { project, revision, store } = await createActiveProjectConfiguration(
      createMemoryDatabase(),
      routeConfig("forgejo.pull_request_comment_created"),
    );
    const provider = createForgejoCommentTriggerProvider({
      configurationStoreForProject: () => store,
      connectionFor: async () => CONNECTION,
    });
    const accepted = await matchNamed(provider, project, revision, "pull-request-comment-created");
    assert.deepEqual(accepted.triggerContext.reactionSubject, { kind: "comment", id: 5 });
    const issueRoute = await createActiveProjectConfiguration(
      createMemoryDatabase(),
      routeConfig("forgejo.issue_comment_created"),
    );
    const issueOnly = createForgejoCommentTriggerProvider({
      configurationStoreForProject: () => issueRoute.store,
      connectionFor: async () => CONNECTION,
    });
    const crossed = await issueOnly.match(
      await triggerFor("pull-request-comment-created", issueRoute.project, issueRoute.revision),
    );
    assert.equal(crossed, "trigger_filters_rejected");
  });
});

function routeConfig(on: string) {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "forgejo-comment",
        on,
        max_runtime: "2h",
        filters: { from_users: ["*"] },
        steps: [
          {
            id: "reply",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "default" },
            prompt: [{ text: "Handle it" }],
          },
        ],
      },
    ],
  };
}

function target(projectId: string, configurationRevisionId: string) {
  return {
    projectId,
    organizationId: "org-1",
    configurationRevisionId,
    connectionId: CONNECTION.id,
    resourceId: "1",
  };
}

async function matchNamed(
  provider: ReturnType<typeof createForgejoCommentTriggerProvider>,
  project: { organizationId: string; id: string },
  revision: { id: string },
  name: string,
) {
  const matched = await provider.match(await triggerFor(name, project, revision));
  if (typeof matched === "string") throw new Error(matched);
  const accepted = matched[0];
  if (accepted === undefined || !isAcceptedTriggerProviderMatch(accepted)) {
    throw new Error("expected accepted comment match");
  }
  return accepted;
}

async function triggerFor(
  name: string,
  project: { organizationId: string; id: string },
  revision: { id: string },
) {
  const fixtures = await loadForgejoContractFixtures();
  const delivery = deliveryByName(fixtures, name);
  return {
    providerEventReceiptId: "receipt-1",
    organizationId: project.organizationId,
    projectId: project.id,
    configurationRevisionId: revision.id,
    source: "forgejo.issue_comment",
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
