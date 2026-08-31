import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { readJson } from "../../providers/forgejo/contract-test-read.js";
import {
  classifyForgejoReviewComment,
  classifyForgejoTimelineRecord,
  createForgejoHydrationConsumer,
  createMemoryForgejoHydrationStore,
  type ForgejoHydrationClient,
} from "./hydration.js";
import type { ForgejoReconciliationSignal } from "./normalize.js";
import type { ForgejoVerifiedDelivery } from "./webhook.js";

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../providers/forgejo/contract-fixtures",
);

describe("Forgejo hydration classification", () => {
  it("recovers issue label additions from timeline type=label body=1", async () => {
    const timeline = readList(await readJson(join(fixturesRoot, "hydration/timeline-issue.json")));
    const recovered = timeline.flatMap((record) => {
      const classified = classifyForgejoTimelineRecord(record, "issue");
      return classified === undefined ? [] : [classified];
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.semanticEvent, "forgejo.issue_label_added");
    assert.equal(recovered[0]?.sourceRecordKind, "label");
    assert.equal(recovered[0]?.reactionSubject, "issue");
  });

  it("recovers pull-request labels and submitted reviews without a review reaction subject", async () => {
    const timeline = readList(await readJson(join(fixturesRoot, "hydration/timeline-pr.json")));
    const recovered = timeline.flatMap((record) => {
      const classified = classifyForgejoTimelineRecord(record, "pull_request");
      return classified === undefined ? [] : [classified];
    });
    assert.deepEqual(
      recovered.map((event) => [event.semanticEvent, event.reactionSubject]),
      [
        ["forgejo.pull_request_label_added", "pull_request"],
        ["forgejo.pull_request_review", null],
      ],
    );
  });

  it("recovers inline review comments as exact reaction subjects", async () => {
    const comments = readList(await readJson(join(fixturesRoot, "hydration/review-comments.json")));
    const recovered = classifyForgejoReviewComment(comments[0]);
    assert.equal(recovered?.semanticEvent, "forgejo.pull_request_review_comment");
    assert.equal(recovered?.reactionSubject, "review_comment");
    assert.equal(recovered?.sourceRecordId, 7);
  });
});

describe("Forgejo hydration consumer", () => {
  it("seeds a missing cursor without emitting history", async () => {
    const timeline = readList(await readJson(join(fixturesRoot, "hydration/timeline-issue.json")));
    const store = createMemoryForgejoHydrationStore();
    const recovered: string[] = [];
    const consumer = createForgejoHydrationConsumer({
      store,
      client: fakeClient(timeline, []),
      onRecovered: (event) => {
        recovered.push(`${event.semanticEvent}:${String(event.sourceRecordId)}`);
        return Promise.resolve();
      },
    });
    await consumer.consume({ receiptId: "r1", delivery: testDelivery(), signal: labelSignal(3) });
    assert.deepEqual(recovered, []);
    assert.equal(
      await store.getCursor({
        connectionId: "conn-1",
        repositoryId: 1,
        subjectKind: "issue",
        subjectId: 3,
        recordKind: "timeline",
      }),
      3,
    );
  });

  it("recovers later label records once after a seeded cursor", async () => {
    const timeline = readList(await readJson(join(fixturesRoot, "hydration/timeline-issue.json")));
    const store = createMemoryForgejoHydrationStore();
    await store.seedCursor(
      {
        connectionId: "conn-1",
        repositoryId: 1,
        subjectKind: "issue",
        subjectId: 3,
        recordKind: "timeline",
      },
      2,
    );
    const recovered: string[] = [];
    const consumer = createForgejoHydrationConsumer({
      store,
      client: fakeClient(timeline, []),
      onRecovered: (event) => {
        recovered.push(`${event.semanticEvent}:${String(event.sourceRecordId)}`);
        return Promise.resolve();
      },
    });
    const delivery = testDelivery();
    const signal = labelSignal(3);
    await consumer.consume({ receiptId: "r2", delivery, signal });
    await consumer.consume({ receiptId: "r3", delivery, signal });
    assert.deepEqual(recovered, ["forgejo.issue_label_added:3"]);
  });

  it("leaves the cursor unchanged when the timeline API fails", async () => {
    const store = createMemoryForgejoHydrationStore();
    await store.seedCursor(
      {
        connectionId: "conn-1",
        repositoryId: 1,
        subjectKind: "issue",
        subjectId: 3,
        recordKind: "timeline",
      },
      0,
    );
    const consumer = createForgejoHydrationConsumer({
      store,
      client: {
        listTimeline: () => Promise.reject(new Error("Forgejo unavailable")),
        listReviews: () => Promise.resolve([]),
        listReviewComments: () => Promise.resolve([]),
      },
    });
    await assert.rejects(
      () =>
        consumer.consume({
          receiptId: "r1",
          delivery: testDelivery(),
          signal: labelSignal(3),
        }),
      /Forgejo unavailable/u,
    );
    assert.equal(
      await store.getCursor({
        connectionId: "conn-1",
        repositoryId: 1,
        subjectKind: "issue",
        subjectId: 3,
        recordKind: "timeline",
      }),
      0,
    );
  });
});

function fakeClient(
  timeline: readonly unknown[],
  comments: readonly unknown[],
): ForgejoHydrationClient {
  return {
    listTimeline: () => Promise.resolve(timeline),
    listReviews: () => Promise.resolve([]),
    listReviewComments: () => Promise.resolve(comments),
  };
}

function testDelivery(): ForgejoVerifiedDelivery {
  return {
    connectionId: "conn-1",
    organizationId: "org_1",
    repositoryId: 1,
    deliveryId: "delivery-1",
    event: "issues",
    eventType: "issue_label",
    signatureHash: "sig",
    rawBody: new Uint8Array(),
    receivedAt: new Date(),
  };
}

function readList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function labelSignal(number: number): ForgejoReconciliationSignal {
  return {
    type: "incomplete_label",
    rawFamily: "forgejo.issues",
    expectedSemantic: "forgejo.issue_label_added",
    text: "",
    labels: [],
    context: {
      deliveryId: "delivery-1",
      instanceId: "instance-1",
      connectionId: "conn-1",
      connectionSlug: "forgejo",
      repository: {
        id: 1,
        full_name: "t00org/t00repo",
        owner: "t00org",
        name: "t00repo",
        default_branch: "main",
        html_url: "https://forgejo.example.test/t00org/t00repo",
      },
      actor: { id: 2, login: "t00bot" },
      subject: {
        kind: "issue",
        id: number,
        number,
        html_url: `https://forgejo.example.test/t00org/t00repo/issues/${String(number)}`,
      },
      event: "forgejo.issues",
      action: "label_updated",
      ref: null,
      htmlUrl: null,
    },
  };
}
