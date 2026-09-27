import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it, vi } from "vitest";
import { z } from "zod";
import { FORGEJO_ENRICHMENT_STALE_MS } from "../../db/forgejo-enrichment.js";
import {
  createForgejoRoutedMemoryDatabase,
  MEMORY_FORGEJO_CONNECTION_ID,
} from "../../db/test-utils/forgejo-route.js";
import type { Database, DurableProviderEvent } from "../../db/types.js";
import type { ForgejoTimelineEntry } from "../../providers/forgejo/client.js";
import {
  createForgejoWebhookSource,
  FORGEJO_ENRICHMENT_DUPLICATE_BUDGET_MS,
  type ForgejoWebhookSourceOptions,
} from "./webhook.js";
import { hashForgejoSignature } from "./webhook-verify.js";

const SECRET = "the-answer-is-42";
const ENDPOINT = `https://hub.example.test/api/integrations/forgejo/events/${MEMORY_FORGEJO_CONNECTION_ID}`;
const CREDENTIALS = { instanceBaseUrl: "https://git.example.test", accessToken: "tok" };

/**
 * Enrichment against the real memory store, so the "enrichment pending" marker is the
 * store's own, not a hand-rolled fake. Two deliveries sharing a signature must never
 * both enrich or both dispatch while one is still enriching.
 */
describe("Forgejo webhook enrichment", () => {
  it("enriches the owning delivery, persists it, and dispatches it once", async () => {
    const database = await routedDatabase();
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = await started(webhook(database, timelineDeps()), dispatched);

    const response = await endpoint.handle(labelUpdatedRequest("delivery-1"));

    assert.equal(response.status, 200);
    assert.equal(dispatched.length, 1);
    assert.deepEqual(addedLabelsOf(dispatched[0]?.payload), ["bug"]);
  });

  it("replays the persisted enrichment for a later duplicate without touching the timeline", async () => {
    const database = await routedDatabase();
    let timelineCalls = 0;
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = await started(
      webhook(database, {
        ...timelineDeps(),
        timelineClient: {
          listIssueTimeline: () => {
            timelineCalls += 1;
            return Promise.resolve([labelEntry()]);
          },
        },
      }),
      dispatched,
    );

    await endpoint.handle(labelUpdatedRequest("delivery-1"));
    await endpoint.handle(labelUpdatedRequest("delivery-2"));

    assert.equal(timelineCalls, 1);
    assert.equal(dispatched.length, 2);
    assert.deepEqual(addedLabelsOf(dispatched[1]?.payload), ["bug"]);
  });

  it("answers a fresh duplicate 200 without dispatching while the owner is still enriching", async () => {
    const database = await routedDatabase();
    const gate = deferred();
    let timelineEntered = false;
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = await started(
      webhook(database, {
        ...timelineDeps(),
        timelineClient: {
          listIssueTimeline: async () => {
            timelineEntered = true;
            await gate.promise;
            return [labelEntry()];
          },
        },
      }),
      dispatched,
    );

    const owner = endpoint.handle(labelUpdatedRequest("delivery-owner"));
    await vi.waitFor(() => {
      if (!timelineEntered) throw new Error("owner has not started enriching yet");
    });

    // 200, not 503: marker is moments old, owner still has budget. dispatches nothing
    // on this delivery, only the owner's does, below.
    const duplicate = await endpoint.handle(labelUpdatedRequest("delivery-duplicate"));
    assert.equal(duplicate.status, 200);
    assert.equal(dispatched.length, 0);

    gate.resolve();
    assert.equal((await owner).status, 200);
    assert.equal(dispatched.length, 1);
    assert.deepEqual(addedLabelsOf(dispatched[0]?.payload), ["bug"]);
  });

  it("still answers an aged-but-not-stale duplicate 200, not yet a takeover", async () => {
    let now = new Date();
    const database = await routedDatabase({ now: () => now });
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = await started(webhook(database, timelineDeps()), dispatched);

    const request = labelUpdatedRequest("delivery-owner-aged");
    const owner = await database.acceptForgejoEvent({
      connectionId: MEMORY_FORGEJO_CONNECTION_ID,
      repositoryId: 9001,
      deliveryId: "delivery-owner-aged",
      signatureHash: signatureHashOf(await request.clone().text()),
      source: "forgejo.issues",
      repo: "acme/widgets",
      payload: {},
      receivedAt: now,
      enrichmentPending: true,
    });
    assert.equal(owner.status, "accepted");

    // past the owner's budget but nowhere near stale: something is actually stuck.
    now = new Date(now.getTime() + FORGEJO_ENRICHMENT_DUPLICATE_BUDGET_MS + 1);
    const duplicate = await endpoint.handle(labelUpdatedRequest("delivery-owner-aged"));

    assert.equal(duplicate.status, 200);
    assert.equal(dispatched.length, 0);
  });

  it("lets exactly one duplicate take over a receipt its owner abandoned", async () => {
    let now = new Date();
    const database = await routedDatabase({ now: () => now });
    let timelineCalls = 0;
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = await started(
      webhook(database, {
        ...timelineDeps(),
        timelineClient: {
          listIssueTimeline: () => {
            timelineCalls += 1;
            return Promise.resolve([labelEntry()]);
          },
        },
      }),
      dispatched,
    );

    // The owner accepted, then died before completing: its marker is all that is left.
    const request = labelUpdatedRequest("delivery-crashed");
    const crashed = await database.acceptForgejoEvent({
      connectionId: MEMORY_FORGEJO_CONNECTION_ID,
      repositoryId: 9001,
      deliveryId: "delivery-crashed",
      signatureHash: signatureHashOf(await request.clone().text()),
      source: "forgejo.issues",
      repo: "acme/widgets",
      payload: {},
      receivedAt: now,
      enrichmentPending: true,
    });
    assert.equal(crashed.status, "accepted");

    now = new Date(now.getTime() + FORGEJO_ENRICHMENT_STALE_MS + 1);
    const responses = await Promise.all([
      endpoint.handle(labelUpdatedRequest("delivery-a")),
      endpoint.handle(labelUpdatedRequest("delivery-b")),
    ]);

    // exactly one wins the takeover and dispatches; the other answers 200 too. order
    // is a race, so compare as a sorted set.
    assert.deepEqual(
      responses.map((response) => response.status).sort((a, b) => a - b),
      [200, 200],
    );
    assert.equal(timelineCalls, 1);
    assert.equal(dispatched.length, 1);
  });

  it("dispatches un-enriched when the Forgejo instance is too slow", async () => {
    const database = await routedDatabase();
    const dispatched: DurableProviderEvent[] = [];
    let claimed = false;
    const endpoint = await started(
      webhook(database, {
        ...timelineDeps(),
        enrichmentDeadlineMs: 50,
        timelineClient: { listIssueTimeline: ({ signal }) => untilAborted(signal) },
        claimTimelineEntries: (_connectionId, ids) => {
          claimed = true;
          return Promise.resolve(new Set(ids));
        },
      }),
      dispatched,
    );

    const response = await endpoint.handle(labelUpdatedRequest("delivery-slow"));

    assert.equal(response.status, 200);
    assert.equal(dispatched.length, 1);
    assert.equal(addedLabelsOf(dispatched[0]?.payload), undefined);
    assert.equal(claimed, false);
  });

  it("clears the marker after a deadline, so a later duplicate is dispatched again", async () => {
    const database = await routedDatabase();
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = await started(
      webhook(database, {
        ...timelineDeps(),
        enrichmentDeadlineMs: 50,
        timelineClient: { listIssueTimeline: ({ signal }) => untilAborted(signal) },
      }),
      dispatched,
    );

    await endpoint.handle(labelUpdatedRequest("delivery-slow"));
    await endpoint.handle(labelUpdatedRequest("delivery-redeliver"));

    assert.equal(dispatched.length, 2);
  });

  it("does not claim entries a late timeline answer brings back after the deadline", async () => {
    const database = await routedDatabase();
    let claimed = false;
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = await started(
      webhook(database, {
        ...timelineDeps(),
        enrichmentDeadlineMs: 50,
        // Answers only once aborted, i.e. a response that crossed the deadline.
        timelineClient: {
          listIssueTimeline: ({ signal }) =>
            new Promise<ForgejoTimelineEntry[]>((resolve) => {
              signal?.addEventListener("abort", () => resolve([labelEntry()]));
            }),
        },
        claimTimelineEntries: (_connectionId, ids) => {
          claimed = true;
          return Promise.resolve(new Set(ids));
        },
      }),
      dispatched,
    );

    await endpoint.handle(labelUpdatedRequest("delivery-late"));

    assert.equal(claimed, false);
    assert.equal(addedLabelsOf(dispatched[0]?.payload), undefined);
  });

  it("still dispatches when a client ignores the deadline signal entirely", async () => {
    const database = await routedDatabase();
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = await started(
      webhook(database, {
        ...timelineDeps(),
        enrichmentDeadlineMs: 50,
        timelineClient: { listIssueTimeline: () => new Promise(() => undefined) },
      }),
      dispatched,
    );

    const response = await endpoint.handle(labelUpdatedRequest("delivery-stuck"));

    assert.equal(response.status, 200);
    assert.equal(dispatched.length, 1);
  });

  it("still dispatches the enriched event when completing fails", async () => {
    const database = await routedDatabase();
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = await started(
      webhook(database, {
        ...timelineDeps(),
        completeEnrichment: () => Promise.reject(new Error("db hiccup")),
      }),
      dispatched,
    );

    const response = await endpoint.handle(labelUpdatedRequest("delivery-1"));

    assert.equal(response.status, 200);
    assert.deepEqual(addedLabelsOf(dispatched[0]?.payload), ["bug"]);
  });

  it("does not mark a delivery that has nothing to enrich", async () => {
    const database = await routedDatabase();
    const pending: (boolean | undefined)[] = [];
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = await started(
      webhook(database, {
        ...timelineDeps(),
        accept: (input) => {
          pending.push(input.enrichmentPending);
          return database.acceptForgejoEvent(input);
        },
      }),
      dispatched,
    );

    await endpoint.handle(signedRequest(issueCommentBody(), "issue_comment", "delivery-c"));

    assert.deepEqual(pending, [false]);
    assert.equal(dispatched.length, 1);
  });

  it("recovers an empty review's text through the same owner-only path", async () => {
    const database = await routedDatabase();
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = await started(
      webhook(database, {
        credentialsForConnection: () => Promise.resolve(CREDENTIALS),
        reviewClient: {
          listPullReviews: () =>
            Promise.resolve([
              {
                id: 501,
                userLogin: "trillian",
                state: "COMMENT",
                submittedAtMs: Date.now(),
                updatedAtMs: Date.now(),
                body: undefined,
              },
            ]),
          listPullReviewComments: () =>
            Promise.resolve([
              {
                id: 9001,
                body: "this loop never terminates on an empty slice",
                path: "src/widget.ts",
                line: 3,
                side: "RIGHT" as const,
                diffHunk: "@@ -1,3 +1,3 @@\n-old\n+new",
                commitId: "c0ffee0000000000000000000000000000000001",
                htmlUrl: "https://git.example.test/acme/widgets/pulls/2/files#issuecomment-9001",
                userLogin: "trillian",
                createdAt: "2026-09-25T12:04:40Z",
              },
            ]),
        },
      }),
      dispatched,
    );

    const response = await endpoint.handle(emptyReviewRequest());

    assert.equal(response.status, 200);
    assert.equal(
      reviewContentOf(dispatched[0]?.payload),
      "this loop never terminates on an empty slice",
    );
  });
});

function routedDatabase(options: { now?: () => Date } = {}): Promise<Database> {
  return createForgejoRoutedMemoryDatabase({ ...options, webhookSecret: SECRET });
}

function webhook(
  database: Database,
  overrides: Partial<ForgejoWebhookSourceOptions>,
): ReturnType<typeof createForgejoWebhookSource> {
  return createForgejoWebhookSource({
    findConnection: async (id) => {
      const connection = await database.findForgejoConnection(id);
      // -1, not connection.accountId: several payloads here use "trillian" as sender
      // to exercise enrichment, not the own-account drop, and carry no sender id.
      return connection === undefined
        ? undefined
        : {
            id,
            webhookSecret: connection.webhookSecret,
            accountId: -1,
            credentials: {
              instanceBaseUrl: connection.instanceBaseUrl,
              accessToken: connection.accessToken,
            },
          };
    },
    accept: (input) => database.acceptForgejoEvent(input),
    completeEnrichment: (receiptId, payload) =>
      database.completeForgejoEnrichment(receiptId, payload),
    ...overrides,
  });
}

async function started(
  endpoint: ReturnType<typeof createForgejoWebhookSource>,
  dispatched: DurableProviderEvent[],
) {
  await endpoint.start((event) => {
    dispatched.push(event);
    return Promise.resolve();
  });
  return endpoint;
}

function timelineDeps() {
  return {
    credentialsForConnection: () => Promise.resolve(CREDENTIALS),
    timelineClient: {
      listIssueTimeline: () => Promise.resolve([labelEntry()]),
    } as NonNullable<ForgejoWebhookSourceOptions["timelineClient"]>,
    claimTimelineEntries: (_connectionId: string, ids: readonly number[]) =>
      Promise.resolve(new Set(ids)),
  };
}

function labelEntry(): ForgejoTimelineEntry {
  return {
    id: 501,
    type: "label",
    body: "1",
    createdAtMs: Date.now(),
    userLogin: "zaphod",
    labelName: "bug",
    assigneeLogin: undefined,
    removedAssignee: false,
  };
}

/** Never resolves; rejects the moment the deadline aborts it, like a real fetch. */
function untilAborted(signal: AbortSignal | undefined): Promise<ForgejoTimelineEntry[]> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Same body every time, so every call shares one signature: a duplicate, not a new event.
const LABEL_UPDATED_BODY = JSON.stringify({
  action: "label_updated",
  repository: { id: 9001, full_name: "acme/widgets" },
  issue: { number: 42, labels: [{ name: "bug" }] },
  sender: { login: "zaphod" },
});

function labelUpdatedRequest(deliveryId: string): Request {
  return signedRequest(LABEL_UPDATED_BODY, "issues", deliveryId);
}

function emptyReviewRequest(): Request {
  const body = JSON.stringify({
    action: "reviewed",
    repository: { id: 9001, full_name: "acme/widgets" },
    pull_request: { number: 2 },
    review: { type: "pull_request_review_comment", content: "" },
    sender: { login: "trillian" },
  });
  return signedRequest(body, "pull_request_comment", "delivery-review-1");
}

function issueCommentBody(): string {
  return JSON.stringify({
    action: "created",
    repository: { id: 9001, full_name: "acme/widgets" },
    issue: { number: 42, title: "Improbability drive stalls", body: "on cold mornings" },
    comment: { body: "@paseo have a look", user: { login: "trillian" } },
    sender: { login: "trillian" },
  });
}

function signedRequest(body: string, event: string, deliveryId: string): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "X-Forgejo-Event": event,
      "X-Forgejo-Delivery": deliveryId,
      "X-Hub-Signature-256": `sha256=${sign(body)}`,
    }),
    body,
  });
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function signatureHashOf(body: string): string {
  return hashForgejoSignature(sign(body));
}

const EnrichedPayloadSchema = z.object({ addedLabels: z.array(z.string()).optional() });

function addedLabelsOf(payload: unknown): string[] | undefined {
  return EnrichedPayloadSchema.parse(payload).addedLabels;
}

const ReviewContentSchema = z.object({
  payload: z.object({ review: z.object({ content: z.string() }) }),
});

/** The dispatched payload for Forgejo is a whole `NormalizedForgejoEvent`, carrying the
 * raw webhook body under its own `payload`; this reads the review text in there. */
function reviewContentOf(payload: unknown): string {
  return ReviewContentSchema.parse(payload).payload.review.content;
}
