import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import { createForgejoApiClient } from "../../providers/forgejo/client.js";
import type { ForgejoReviewComment, ForgejoReviewSummary } from "../../providers/forgejo/client.js";
import { loadForgejoApiFixture, loadForgejoDelivery } from "../fixtures/forgejo/index.js";
import {
  ForgeWebhookPayloadSchema,
  normalizeForgejoEventType,
  readForgeEventIdentity,
} from "./events.js";
import type { NormalizedForgejoEvent } from "./events.js";
import { enrichForgejoWebhookEvent } from "./enrichment.js";

const CONNECTION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const CREDENTIALS = { instanceBaseUrl: "https://git.example.test", accessToken: "tok" };

// issue-timeline-after-label.json is one continuous timeline: comment, bug added,
// triage added, both removed. Each test below sees only the prefix that existed at
// its own delivery time.
describe("Forgejo enrichment, against a real timeline", () => {
  it("derives the added label from the timeline", async () => {
    const event = await enrichForgejoWebhookEvent(
      normalizedEvent("issue-label-added"),
      deps("issue-timeline-after-label", 2),
      undefined,
      "receipt-1",
    );
    assert.deepEqual(event.addedLabels, ["bug"]);
    assert.equal(event.addedAssignees, undefined);
  });

  it("keeps both labels added in the same delivery", async () => {
    const event = await enrichForgejoWebhookEvent(
      normalizedEvent("issue-label-triage-added"),
      deps("issue-timeline-after-label", 3),
      undefined,
      "receipt-1",
    );
    assert.deepEqual([...(event.addedLabels ?? [])].sort(), ["bug", "triage"]);
  });

  it("claims each timeline entry once, so a racing duplicate under another receipt adds nothing", async () => {
    const claims = new Map<string, Map<number, string>>();
    const shared = deps("issue-timeline-after-label", 3, claims);

    const first = await enrichForgejoWebhookEvent(
      normalizedEvent("issue-label-triage-added"),
      shared,
      undefined,
      "receipt-a",
    );
    assert.deepEqual([...(first.addedLabels ?? [])].sort(), ["bug", "triage"]);

    const racing = await enrichForgejoWebhookEvent(
      normalizedEvent("issue-label-triage-added"),
      shared,
      undefined,
      "receipt-b",
    );
    assert.deepEqual(racing.addedLabels, []);
  });

  it("reclaims its own prior claim under the same receipt, instead of losing it", async () => {
    const claims = new Map<string, Map<number, string>>();
    const shared = deps("issue-timeline-after-label", 3, claims);

    const first = await enrichForgejoWebhookEvent(
      normalizedEvent("issue-label-triage-added"),
      shared,
      undefined,
      "receipt-a",
    );
    assert.deepEqual([...(first.addedLabels ?? [])].sort(), ["bug", "triage"]);

    const takeover = await enrichForgejoWebhookEvent(
      normalizedEvent("issue-label-triage-added"),
      shared,
      undefined,
      "receipt-a",
    );
    assert.deepEqual([...(takeover.addedLabels ?? [])].sort(), ["bug", "triage"]);
  });

  it("does not re-derive an add once it is claimed, even from a removal delivery", async () => {
    const claims = new Map<string, Map<number, string>>();
    await enrichForgejoWebhookEvent(
      normalizedEvent("issue-label-triage-added"),
      deps("issue-timeline-after-label", 3, claims),
      undefined,
      "receipt-a",
    );

    const event = await enrichForgejoWebhookEvent(
      normalizedEvent("issue-label-bug-removed"),
      deps("issue-timeline-after-label", undefined, claims),
      undefined,
      "receipt-b",
    );
    assert.deepEqual(event.addedLabels, []);
  });

  it("derives the added assignee from the timeline", async () => {
    const event = await enrichForgejoWebhookEvent(
      normalizedEvent("issue-assigned"),
      deps("issue-timeline-after-assign"),
      undefined,
      "receipt-1",
    );
    assert.deepEqual(event.addedAssignees, ["zaphod"]);
  });

  it("returns the event unchanged when no credentials are wired", async () => {
    const source = normalizedEvent("issue-label-added");
    const event = await enrichForgejoWebhookEvent(source, {
      timelineClient: createForgejoApiClient({ fetch: () => Promise.reject(new Error("unused")) }),
    });
    assert.deepEqual(event, source);
  });

  it("returns the event unchanged when the instance call throws", async () => {
    const source = normalizedEvent("issue-label-added");
    const event = await enrichForgejoWebhookEvent(source, {
      credentialsForConnection: () => Promise.resolve(CREDENTIALS),
      timelineClient: createForgejoApiClient({
        fetch: () => Promise.resolve(new Response("nope", { status: 500 })),
      }),
    });
    assert.deepEqual(event, source);
  });

  it("leaves an unrelated event alone", async () => {
    const source = normalizedEvent("issue-comment-created");
    const event = await enrichForgejoWebhookEvent(source, deps("issue-timeline-after-label"));
    assert.deepEqual(event, source);
  });
});

// normalizedEvent() fixes createdAt at 2026-09-27T17:42:10.000Z, window is
// [17:32:10Z, 17:42:10Z). These entries would sort wrong under a plain string compare
// against that bound but land right when read as real instants.
describe("Forgejo enrichment, against a server that is not in UTC", () => {
  it("includes a timeline entry whose created_at carries a negative offset", async () => {
    const event = await enrichForgejoWebhookEvent(
      normalizedEvent("issue-label-added"),
      depsWithEntries([
        {
          id: 2,
          type: "label",
          body: "1",
          created_at: "2026-09-27T10:41:10-07:00",
          user: { login: "zaphod" },
          label: { name: "bug" },
        },
      ]),
    );
    assert.deepEqual(event.addedLabels, ["bug"]);
  });

  it("excludes a timeline entry whose created_at carries a positive offset", async () => {
    const event = await enrichForgejoWebhookEvent(
      normalizedEvent("issue-label-added"),
      depsWithEntries([
        {
          id: 2,
          type: "label",
          body: "1",
          created_at: "2026-09-27T23:01:40+05:30",
          user: { login: "zaphod" },
          label: { name: "bug" },
        },
      ]),
    );
    assert.deepEqual(event.addedLabels, []);
  });
});

// listIssueTimeline's `since` only bounds the query from below, so an entry created well
// after this delivery could still come back in the same page; recentUntilMs is what
// keeps it from being misattributed to this delivery.
describe("Forgejo enrichment, bounding a candidate from the future too", () => {
  it("excludes a timeline entry created well after this delivery", async () => {
    const event = await enrichForgejoWebhookEvent(
      normalizedEvent("issue-label-added"),
      depsWithEntries([
        {
          id: 2,
          type: "label",
          body: "1",
          created_at: "2026-09-27T17:49:10Z",
          user: { login: "zaphod" },
          label: { name: "bug" },
        },
      ]),
    );
    assert.deepEqual(event.addedLabels, []);
  });

  it("still includes an entry inside the clock-skew allowance", async () => {
    const event = await enrichForgejoWebhookEvent(
      normalizedEvent("issue-label-added"),
      depsWithEntries([
        {
          id: 2,
          type: "label",
          body: "1",
          created_at: "2026-09-27T17:42:40Z",
          user: { login: "zaphod" },
          label: { name: "bug" },
        },
      ]),
    );
    assert.deepEqual(event.addedLabels, ["bug"]);
  });
});

// A review made up only of inline comments arrives with review.content: "".
describe("Forgejo enrichment, a review with no summary text", () => {
  it("fills review.content from the review's own comments", async () => {
    const source = reviewEvent("");
    const event = await enrichForgejoWebhookEvent(source, reviewDeps());
    assert.equal(readReviewContent(event.payload), "this loop never terminates on an empty slice");
    assert.notEqual(event.payload, source.payload);
  });

  it("adds a structured review.comments list alongside review.content", async () => {
    const source = reviewEvent("");
    const event = await enrichForgejoWebhookEvent(source, reviewDeps());
    assert.deepEqual(readReviewComments(event.payload), [
      {
        id: 9001,
        body: "this loop never terminates on an empty slice",
        path: "src/widget.ts",
        line: 3,
        side: "RIGHT",
        diff_hunk: "@@ -1,3 +1,3 @@\n-old\n+new",
        commit_id: "c0ffee0000000000000000000000000000000001",
        html_url: "https://git.example.test/acme/widgets/pulls/2/files#issuecomment-9001",
        created_at: "2026-09-25T12:04:40Z",
        user: { login: "trillian" },
      },
    ]);
  });

  it("appends the review's inline comments to an already-summarized review's content", async () => {
    const source = reviewEvent("looks good overall");
    const event = await enrichForgejoWebhookEvent(
      source,
      reviewClientWith(
        [
          reviewSummary(501, {
            updatedAtMs: Date.parse(source.createdAt),
            body: "looks good overall",
          }),
        ],
        { 501: [reviewComment(9001, "this loop never terminates on an empty slice")] },
      ),
    );
    assert.equal(
      readReviewContent(event.payload),
      "looks good overall\n\nthis loop never terminates on an empty slice",
    );
    assert.notEqual(event.payload, source.payload);
  });

  it("returns the event unchanged when no review client is wired", async () => {
    const source = reviewEvent("");
    const event = await enrichForgejoWebhookEvent(source, {
      credentialsForConnection: () => Promise.resolve(CREDENTIALS),
    });
    assert.deepEqual(event, source);
  });

  it("returns the event unchanged when no review by that sender is recent enough", async () => {
    const source = reviewEvent("", "someone-else");
    const event = await enrichForgejoWebhookEvent(source, reviewDeps());
    assert.deepEqual(event, source);
  });

  it("returns the event unchanged when the instance call throws", async () => {
    const source = reviewEvent("");
    const event = await enrichForgejoWebhookEvent(source, {
      credentialsForConnection: () => Promise.resolve(CREDENTIALS),
      reviewClient: createForgejoApiClient({
        fetch: () => Promise.resolve(new Response("nope", { status: 500 })),
      }),
    });
    assert.deepEqual(event, source);
  });
});

describe("Forgejo enrichment, picking the review a delivery is about", () => {
  it("finds a review whose draft predates the window but was submitted just now", async () => {
    const source = reviewEvent("");
    const event = await enrichForgejoWebhookEvent(
      source,
      reviewClientWith(
        [
          reviewSummary(600, {
            submittedAtMs: Date.parse("2026-09-25T11:50:00.000Z"),
            updatedAtMs: Date.parse("2026-09-25T12:04:50.000Z"),
          }),
        ],
        { 600: [reviewComment(1, "left this while drafting")] },
      ),
    );
    assert.equal(readReviewContent(event.payload), "left this while drafting");
  });

  it("does not let a quick review beat a longer draft with a later updated_at", async () => {
    const source = reviewEvent("");
    const event = await enrichForgejoWebhookEvent(
      source,
      reviewClientWith(
        [
          reviewSummary(601, {
            submittedAtMs: Date.parse("2026-09-25T12:00:00.000Z"),
            updatedAtMs: Date.parse("2026-09-25T12:00:00.000Z"),
          }),
          reviewSummary(602, {
            submittedAtMs: Date.parse("2026-09-25T11:50:00.000Z"),
            updatedAtMs: Date.parse("2026-09-25T12:04:50.000Z"),
          }),
        ],
        {
          601: [reviewComment(1, "quick take")],
          602: [reviewComment(2, "the draft that took a while")],
        },
      ),
    );
    assert.equal(readReviewContent(event.payload), "the draft that took a while");
  });

  it("never picks a REQUEST_REVIEW row for the same user, however recent", async () => {
    const source = reviewEvent("");
    const event = await enrichForgejoWebhookEvent(
      source,
      reviewClientWith(
        [
          {
            id: 603,
            userLogin: "trillian",
            state: "REQUEST_REVIEW",
            submittedAtMs: Date.parse(source.createdAt),
            updatedAtMs: Date.parse(source.createdAt),
            body: undefined,
          },
        ],
        { 603: [reviewComment(3, "should never surface")] },
      ),
    );
    assert.deepEqual(event, source);
  });

  it("uses the webhook's own content to break a tie the id order alone would get wrong", async () => {
    const source = reviewEvent("the right one");
    const event = await enrichForgejoWebhookEvent(
      source,
      reviewClientWith(
        [
          reviewSummary(610, {
            updatedAtMs: Date.parse(source.createdAt),
            body: "the right one",
          }),
          reviewSummary(611, {
            updatedAtMs: Date.parse(source.createdAt),
            body: "a different review, same sender and verdict",
          }),
        ],
        {
          610: [reviewComment(1, "right review's comment")],
          611: [reviewComment(2, "wrong review's comment")],
        },
      ),
    );
    assert.equal(readReviewContent(event.payload), "the right one\n\nright review's comment");
  });
});

/** A fixture-shaped pull_request_review delivery with review.content set by the caller. */
function reviewEvent(content: string, senderLogin = "trillian"): NormalizedForgejoEvent {
  return {
    id: "delivery-review-1",
    type: "pull_request_review",
    repo: "acme/widgets",
    repositoryId: 1,
    connectionId: CONNECTION_ID,
    createdAt: "2026-09-25T12:05:00.000Z",
    payload: {
      action: "reviewed",
      review: { type: "pull_request_review_comment", content },
      pull_request: { number: 2 },
      repository: { id: 1, full_name: "acme/widgets" },
      sender: { login: senderLogin },
    },
  };
}

const ReviewContentSchema = z.object({ review: z.object({ content: z.string() }) });

function readReviewContent(payload: NormalizedForgejoEvent["payload"]): string {
  return ReviewContentSchema.parse(payload).review.content;
}

const ReviewCommentsSchema = z.object({ review: z.object({ comments: z.array(z.unknown()) }) });

function readReviewComments(payload: NormalizedForgejoEvent["payload"]): unknown[] {
  return ReviewCommentsSchema.parse(payload).review.comments;
}

function reviewDeps() {
  return {
    credentialsForConnection: () => Promise.resolve(CREDENTIALS),
    reviewClient: createForgejoApiClient({
      fetch: (input) => {
        const url = requestUrl(input);
        const page = new URL(url).searchParams.get("page") ?? "1";
        if (page !== "1") return Promise.resolve(Response.json([]));
        return Promise.resolve(
          Response.json(
            url.includes("/comments")
              ? loadForgejoApiFixture("pull-request-review-comments")
              : loadForgejoApiFixture("pull-request-reviews"),
          ),
        );
      },
    }),
  };
}

/** A pull_request_review_comment-verdict review by "trillian", reviewEvent()'s default sender. */
function reviewSummary(id: number, overrides: Partial<ForgejoReviewSummary>): ForgejoReviewSummary {
  return {
    id,
    userLogin: "trillian",
    state: "COMMENT",
    submittedAtMs: 0,
    updatedAtMs: 0,
    body: undefined,
    ...overrides,
  };
}

function reviewComment(id: number, body: string): ForgejoReviewComment {
  return {
    id,
    body,
    path: undefined,
    line: undefined,
    side: undefined,
    diffHunk: undefined,
    commitId: undefined,
    htmlUrl: undefined,
    userLogin: "trillian",
    createdAt: undefined,
  };
}

/** A review client whose comments are looked up by review id. */
function reviewClientWith(
  reviews: readonly ForgejoReviewSummary[],
  commentsByReviewId: Record<number, readonly ForgejoReviewComment[]>,
) {
  return {
    credentialsForConnection: () => Promise.resolve(CREDENTIALS),
    reviewClient: {
      listPullReviews: () => Promise.resolve([...reviews]),
      listPullReviewComments: ({ reviewId }: { reviewId: number }) =>
        Promise.resolve([...(commentsByReviewId[reviewId] ?? [])]),
    },
  };
}

function normalizedEvent(name: string): NormalizedForgejoEvent {
  const fixture = loadForgejoDelivery(name);
  const payload = ForgeWebhookPayloadSchema.parse(fixture.payload);
  const type = normalizeForgejoEventType(fixture.headers["x-forgejo-event"] ?? "unknown");
  const identity = readForgeEventIdentity(payload, type);
  return {
    id: fixture.headers["x-forgejo-delivery"] ?? "delivery-1",
    type,
    repo: identity?.repo ?? "acme/widgets",
    repositoryId: identity?.repositoryId ?? 1,
    connectionId: CONNECTION_ID,
    // fixed to stay within RECENCY_WINDOW_MS of the timeline fixtures' own entries.
    createdAt: "2026-09-27T17:42:10.000Z",
    payload,
  };
}

/** Pass a shared claims map across calls to simulate deliveries racing over the same timeline. */
function deps(
  apiFixtureName: string,
  prefixLength?: number,
  claims: Map<string, Map<number, string>> = new Map(),
) {
  const fixture = loadForgejoApiFixture(apiFixtureName);
  const entries =
    prefixLength === undefined || !Array.isArray(fixture)
      ? fixture
      : fixture.slice(0, prefixLength);
  return {
    credentialsForConnection: () => Promise.resolve(CREDENTIALS),
    timelineClient: createForgejoApiClient({
      // pagination runs until an empty page, so the stub must too.
      fetch: (input) => {
        const page = new URL(requestUrl(input)).searchParams.get("page") ?? "1";
        return Promise.resolve(Response.json(page === "1" ? entries : []));
      },
    }),
    claimTimelineEntries: (
      connectionId: string,
      timelineEntryIds: readonly number[],
      receiptId: string,
    ) => {
      const already = claims.get(connectionId) ?? new Map<number, string>();
      const won = new Set<number>();
      for (const id of timelineEntryIds) {
        const owner = already.get(id);
        if (owner !== undefined && owner !== receiptId) continue;
        already.set(id, receiptId);
        won.add(id);
      }
      claims.set(connectionId, already);
      return Promise.resolve(won);
    },
  };
}

/** Like deps(), but takes raw timeline entry JSON instead of a fixture file. */
function depsWithEntries(entries: readonly unknown[]) {
  return {
    credentialsForConnection: () => Promise.resolve(CREDENTIALS),
    timelineClient: createForgejoApiClient({
      fetch: (input) => {
        const page = new URL(requestUrl(input)).searchParams.get("page") ?? "1";
        return Promise.resolve(Response.json(page === "1" ? entries : []));
      },
    }),
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
