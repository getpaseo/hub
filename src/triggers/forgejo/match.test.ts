import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import { loadForgejoDelivery } from "../fixtures/forgejo/index.js";
import {
  classifyForgejoEvent,
  ForgeWebhookPayloadSchema,
  normalizeForgejoEventType,
  readForgeEventIdentity,
} from "./events.js";
import type { NormalizedForgejoEvent } from "./events.js";
import { matchForgejoTriggers } from "./match.js";

const CONNECTION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_CONNECTION_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

describe("Forgejo classification, against real deliveries", () => {
  it("reads a comment the way GitHub spells it", () => {
    const classified = classifyForgejoEvent(forgejoEvent("issue-comment-created"));
    assert.equal(classified.actor, "zaphod");
    assert.equal(classified.text, "@paseo have a look");
    assert.equal(classified.semanticEvent, "forgejo.issue_comment_created");
  });

  it("calls a comment on a pull request a pull request comment", () => {
    const classified = classifyForgejoEvent(forgejoEvent("pull-request-comment-created"));
    assert.equal(classified.semanticEvent, "forgejo.pull_request_comment_created");
  });

  it("reads an opened issue", () => {
    const classified = classifyForgejoEvent(forgejoEvent("issue-opened"));
    assert.equal(classified.semanticEvent, "forgejo.issue_created");
    assert.equal(classified.actor, "trillian");
    assert.equal(classified.item?.title, "Improbability drive stalls");
  });

  it("reads an opened pull request", () => {
    const classified = classifyForgejoEvent(forgejoEvent("pull-request-opened"));
    assert.equal(classified.semanticEvent, "forgejo.pull_request_created");
    assert.equal(classified.actor, "zaphod");
  });

  it("reads the reviewer and their comment off a real review delivery", () => {
    const classified = classifyForgejoEvent(forgejoEvent("pull-request-review-rejected"));
    assert.equal(classified.semanticEvent, "forgejo.pull_request_review_rejected");
    assert.equal(classified.actor, "trillian");
    assert.equal(classified.text, "needs work");
  });

  it("reads the review's pull request as the item, so a reply can target it", () => {
    const classified = classifyForgejoEvent(forgejoEvent("pull-request-review-approved"));
    assert.equal(classified.item?.type, "pull_request");
    assert.equal(classified.item?.number, 2);
  });

  it("raises pull_request_review_approved for a real approved review", () => {
    const classified = classifyForgejoEvent(forgejoEvent("pull-request-review-approved"));
    assert.equal(classified.semanticEvent, "forgejo.pull_request_review_approved");
  });

  it("raises no semantic event for a review that is only a comment", () => {
    const classified = classifyForgejoEvent(forgejoEvent("pull-request-review-comment"));
    assert.equal(classified.semanticEvent, undefined);
  });

  it("raises pull_request_review_requested for a real review request", () => {
    const classified = classifyForgejoEvent(reviewRequestedEvent());
    assert.equal(classified.semanticEvent, "forgejo.pull_request_review_requested");
    assert.equal(classified.item?.number, 2);
  });

  it("reads the requested reviewer's login off a real review request", () => {
    const classified = classifyForgejoEvent(forgejoEvent("pull-request-review-requested"));
    assert.equal(classified.semanticEvent, "forgejo.pull_request_review_requested");
    assert.equal(classified.requestedReviewer, "trillian");
  });

  it("raises issue_closed for a real issue close", () => {
    const classified = classifyForgejoEvent(forgejoEvent("issue-closed"));
    assert.equal(classified.semanticEvent, "forgejo.issue_closed");
  });

  it("raises issue_reopened for a real issue reopen", () => {
    const classified = classifyForgejoEvent(forgejoEvent("issue-reopened"));
    assert.equal(classified.semanticEvent, "forgejo.issue_reopened");
  });

  it("raises pull_request_closed for a real close without a merge", () => {
    const classified = classifyForgejoEvent(forgejoEvent("pull-request-closed"));
    assert.equal(classified.semanticEvent, "forgejo.pull_request_closed");
  });

  it("raises pull_request_merged, not pull_request_closed, for a real merge", () => {
    const classified = classifyForgejoEvent(forgejoEvent("pull-request-merged"));
    assert.equal(classified.semanticEvent, "forgejo.pull_request_merged");
  });

  it("raises pull_request_reopened for a real pull request reopen", () => {
    const classified = classifyForgejoEvent(forgejoEvent("pull-request-reopened"));
    assert.equal(classified.semanticEvent, "forgejo.pull_request_reopened");
  });

  it("raises pull_request_synchronized for a real sync", () => {
    const classified = classifyForgejoEvent(forgejoEvent("pull-request-synchronized"));
    assert.equal(classified.semanticEvent, "forgejo.pull_request_synchronized");
  });

  it("raises issue_label_added for a real label add", () => {
    const classified = classifyForgejoEvent(
      forgejoEvent("issue-label-added", { addedLabels: ["bug"] }),
    );
    assert.equal(classified.semanticEvent, "forgejo.issue_label_added");
    assert.deepEqual(classified.addedLabels, ["bug"]);
  });

  it("raises pull_request_label_added for a real PR label add", () => {
    const classified = classifyForgejoEvent(
      forgejoEvent("pull-request-label-added", { addedLabels: ["bug"] }),
    );
    assert.equal(classified.semanticEvent, "forgejo.pull_request_label_added");
  });

  it("raises no semantic event for a label add when enrichment found nothing", () => {
    const classified = classifyForgejoEvent(forgejoEvent("issue-label-added"));
    assert.equal(classified.semanticEvent, undefined);
  });

  it("raises issue_assigned for a real assign", () => {
    const classified = classifyForgejoEvent(
      forgejoEvent("issue-assigned", { addedAssignees: ["zaphod"] }),
    );
    assert.equal(classified.semanticEvent, "forgejo.issue_assigned");
    assert.deepEqual(classified.addedAssignees, ["zaphod"]);
  });

  it("raises pull_request_assigned for a real PR assign", () => {
    const classified = classifyForgejoEvent(
      forgejoEvent("pull-request-assigned", { addedAssignees: ["zaphod"] }),
    );
    assert.equal(classified.semanticEvent, "forgejo.pull_request_assigned");
  });

  it("reads the pusher as the actor off a real push delivery", () => {
    const classified = classifyForgejoEvent(forgejoEvent("push"));
    assert.equal(classified.actor, "trillian");
  });

  it("reads the repository off run.repository for an action run delivery", () => {
    const event = forgejoEvent("action-run-failure");
    assert.equal(event.repo, "acme/widgets");
    assert.equal(event.repositoryId, 1);
  });

  it("raises action_run_failure for a real CI run failure, and reads the trigger user", () => {
    const classified = classifyForgejoEvent(forgejoEvent("action-run-failure"));
    assert.equal(classified.semanticEvent, "forgejo.action_run_failure");
    assert.equal(classified.actor, "trillian");
    assert.equal(classified.item, null);
  });

  it("raises action_run_success for a real CI run success", () => {
    const classified = classifyForgejoEvent(forgejoEvent("action-run-success"));
    assert.equal(classified.semanticEvent, "forgejo.action_run_success");
  });
});

describe("Forgejo trigger matching", () => {
  it("matches a trigger written against the raw source name", () => {
    const matched = matchForgejoTriggers(
      configuration(),
      forgejoEvent("issue-comment-created"),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "raw-source"));
  });

  it("matches a trigger written against the semantic name", () => {
    const matched = matchForgejoTriggers(
      configuration(),
      forgejoEvent("issue-comment-created"),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "semantic"));
  });

  it("ignores an event from a repository the trigger does not name", () => {
    const matched = matchForgejoTriggers(
      configuration(),
      forgejoEvent("issue-comment-created"),
      CONNECTION_ID,
    );
    assert.ok(!matched.some((match) => match.trigger.name === "other-repo"));
  });

  it("ignores a comment that does not contain what the trigger waits for", () => {
    const matched = matchForgejoTriggers(
      configuration(),
      forgejoEvent("issue-comment-created"),
      CONNECTION_ID,
    );
    assert.ok(!matched.some((match) => match.trigger.name === "waits-for-marvin"));
  });

  it("matches a push against its raw source name", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.push" }),
      forgejoEvent("push"),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("matches a branches filter naming the pushed branch", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.push", filters: { branches: ["main"] } }),
      forgejoEvent("push"),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("ignores a branches filter naming a branch this push did not touch", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.push", filters: { branches: ["develop"] } }),
      forgejoEvent("push"),
      CONNECTION_ID,
    );
    assert.ok(!matched.some((match) => match.trigger.name === "overridden"));
  });

  it("is case sensitive, unlike the label and assignees filters", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.push", filters: { branches: ["Main"] } }),
      forgejoEvent("push"),
      CONNECTION_ID,
    );
    assert.ok(!matched.some((match) => match.trigger.name === "overridden"));
  });

  it("lets a branches filter of * match any branch", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.push", filters: { branches: ["*"] } }),
      forgejoEvent("push"),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("never matches a push to a tag, even with a branches filter of *", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.push", filters: { branches: ["*"] } }),
      tagPushEvent(),
      CONNECTION_ID,
    );
    assert.ok(!matched.some((match) => match.trigger.name === "overridden"));
  });

  it("matches a trigger written against the action_run_failure source", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.action_run_failure" }),
      forgejoEvent("action-run-failure"),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("matches a trigger written against the action_run_success source", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.action_run_success" }),
      forgejoEvent("action-run-success"),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("matches a push by the pusher named in its from_users filter", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.push", filters: { from_users: ["trillian"] } }),
      forgejoEvent("push"),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("ignores a push from someone the from_users filter does not name", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.push", filters: { from_users: ["marvin"] } }),
      forgejoEvent("push"),
      CONNECTION_ID,
    );
    assert.ok(!matched.some((match) => match.trigger.name === "overridden"));
  });

  it("cannot be handed a trigger that permits nobody, the compiler refuses it first", () => {
    assert.throws(
      () => configuration({ filters: { from_users: [] } }),
      /requires a non-empty filters\.from_users/u,
    );
  });

  it("matches from_users case-insensitively, like the label and assignees filters", () => {
    const matched = matchForgejoTriggers(
      configuration({ filters: { from_users: ["Zaphod"] } }),
      forgejoEvent("issue-comment-created"),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("ignores a trigger bound to a different connection", () => {
    const bound = bindConnection(configuration(), CONNECTION_ID);
    const event = forgejoEvent("issue-comment-created");
    assert.ok(matchForgejoTriggers(bound, event, CONNECTION_ID).length > 0);
    assert.deepEqual(matchForgejoTriggers(bound, event, OTHER_CONNECTION_ID), []);
  });

  it("matches a trigger written against the review source name", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.pull_request_review" }),
      forgejoEvent("pull-request-review-approved"),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("fires a contains filter on text merged from a summary and an inline comment", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.pull_request_review", filters: { contains: "@paseo" } }),
      reviewEvent("see inline\n\n@paseo fix this loop"),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("matches any added label the trigger's label filter names, not just the first", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.issue_label_added", filters: { label: "triage" } }),
      forgejoEvent("issue-label-added", { addedLabels: ["bug", "triage"] }),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("ignores a label filter naming a label this delivery did not add", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.issue_label_added", filters: { label: "triage" } }),
      forgejoEvent("issue-label-added", { addedLabels: ["bug"] }),
      CONNECTION_ID,
    );
    assert.ok(!matched.some((match) => match.trigger.name === "overridden"));
  });

  it("matches an assignees filter naming the assignee this delivery added", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.issue_assigned", filters: { assignees: ["zaphod"] } }),
      forgejoEvent("issue-assigned", { addedAssignees: ["zaphod"] }),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("matches an assignees filter regardless of case, like the label filter does", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.issue_assigned", filters: { assignees: ["Zaphod"] } }),
      forgejoEvent("issue-assigned", { addedAssignees: ["zaphod"] }),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("lets an assignees filter of * match any added assignee", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.issue_assigned", filters: { assignees: ["*"] } }),
      forgejoEvent("issue-assigned", { addedAssignees: ["zaphod"] }),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("ignores an assignees filter naming someone this delivery did not assign", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.issue_assigned", filters: { assignees: ["marvin"] } }),
      forgejoEvent("issue-assigned", { addedAssignees: ["zaphod"] }),
      CONNECTION_ID,
    );
    assert.ok(!matched.some((match) => match.trigger.name === "overridden"));
  });

  it("matches a trigger written against the review-approved semantic name", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.pull_request_review_approved" }),
      forgejoEvent("pull-request-review-approved"),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("matches a reviewers filter naming the requested reviewer", () => {
    const matched = matchForgejoTriggers(
      configuration({
        on: "forgejo.pull_request_review_requested",
        filters: { reviewers: ["trillian"] },
      }),
      reviewRequestedEvent(),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("matches a reviewers filter regardless of case", () => {
    const matched = matchForgejoTriggers(
      configuration({
        on: "forgejo.pull_request_review_requested",
        filters: { reviewers: ["Trillian"] },
      }),
      reviewRequestedEvent(),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("lets a reviewers filter of * match any requested reviewer", () => {
    const matched = matchForgejoTriggers(
      configuration({
        on: "forgejo.pull_request_review_requested",
        filters: { reviewers: ["*"] },
      }),
      reviewRequestedEvent(),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("ignores a reviewers filter naming someone this delivery did not request", () => {
    const matched = matchForgejoTriggers(
      configuration({
        on: "forgejo.pull_request_review_requested",
        filters: { reviewers: ["marvin"] },
      }),
      reviewRequestedEvent(),
      CONNECTION_ID,
    );
    assert.ok(!matched.some((match) => match.trigger.name === "overridden"));
  });

  it("matches a trigger written against the review-requested semantic name", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.pull_request_review_requested" }),
      reviewRequestedEvent(),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  it("matches an issue_assigned trigger with no assignees filter against any assignee", () => {
    const matched = matchForgejoTriggers(
      configuration({ on: "forgejo.issue_assigned" }),
      forgejoEvent("issue-assigned", { addedAssignees: ["zaphod"] }),
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "overridden"));
  });

  // configuration/store.ts resolves an authored `repo` filter to the repository's
  // numeric id at save time; this is what a delivery's own repo field is matched
  // against, so a rename of the repository after the trigger was saved still matches.
  it("matches by repository id even after the delivery's own repo name has changed", () => {
    const event = { ...forgejoEvent("issue-comment-created"), repo: "acme/renamed" };
    const matched = matchForgejoTriggers(
      {
        triggers: [
          {
            name: "resolved-repo",
            on: "forgejo.issue_comment",
            filters: {
              from_users: ["*"],
              repo: "acme/widgets",
              resourceId: String(event.repositoryId),
              connectionId: CONNECTION_ID,
            },
          },
        ],
      },
      event,
      CONNECTION_ID,
    );
    assert.ok(matched.some((match) => match.trigger.name === "resolved-repo"));
  });

  it("never matches an authored repo filter that was never resolved to a resourceId", () => {
    const event = forgejoEvent("issue-comment-created");
    const matched = matchForgejoTriggers(
      {
        triggers: [
          {
            name: "unresolved-repo",
            on: "forgejo.issue_comment",
            filters: { from_users: ["*"], repo: event.repo, connectionId: CONNECTION_ID },
          },
        ],
      },
      event,
      CONNECTION_ID,
    );
    assert.deepEqual(matched, []);
  });
});

describe("Forgejo configuration compiles the assignees filter", () => {
  it("accepts filters.assignees on a forgejo event", () => {
    const compiled = configuration({
      on: "forgejo.issue_assigned",
      filters: { assignees: ["zaphod"] },
    });
    const trigger = compiled.triggers.find((candidate) => candidate.name === "overridden");
    assert.deepEqual(trigger?.filters?.assignees, ["zaphod"]);
  });

  it("accepts filters.reviewers on forgejo.pull_request_review_requested", () => {
    const compiled = configuration({
      on: "forgejo.pull_request_review_requested",
      filters: { reviewers: ["trillian"] },
    });
    const trigger = compiled.triggers.find((candidate) => candidate.name === "overridden");
    assert.deepEqual(trigger?.filters?.reviewers, ["trillian"]);
  });
});

/** Stamp a resolved connection onto every compiled trigger, as trigger routing does. */
function bindConnection(
  config: ReturnType<typeof configuration>,
  connectionId: string,
): ReturnType<typeof configuration> {
  return {
    ...config,
    triggers: config.triggers.map((trigger) => ({
      ...trigger,
      filters: { ...trigger.filters, connectionId },
    })),
  };
}

function configuration(overridden?: { on?: string; filters?: Record<string, unknown> }) {
  const base = {
    id: "work",
    environment: "runner",
    max_runtime: "1h",
    idle_timeout: "5m",
    agent: { provider: "codex" },
    prompt: [{ text: "Work from ${{ paseo.context }}" }],
  };
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "raw-source",
        on: "forgejo.issue_comment",
        max_runtime: "2h",
        filters: { from_users: ["zaphod"], connection: "acme-forge" },
        steps: [base],
      },
      {
        name: "semantic",
        on: "forgejo.issue_comment_created",
        max_runtime: "2h",
        filters: { from_users: ["*"], connection: "acme-forge" },
        steps: [base],
      },
      {
        name: "other-repo",
        on: "forgejo.issue_comment",
        max_runtime: "2h",
        filters: { from_users: ["*"], repo: "acme/other", connection: "acme-forge" },
        steps: [base],
      },
      {
        name: "waits-for-marvin",
        on: "forgejo.issue_comment",
        max_runtime: "2h",
        filters: { from_users: ["*"], contains: "@marvin", connection: "acme-forge" },
        steps: [base],
      },
      ...(overridden === undefined
        ? []
        : [
            {
              name: "overridden",
              on: overridden.on ?? "forgejo.issue_comment",
              max_runtime: "2h",
              filters: { from_users: ["*"], connection: "acme-forge", ...overridden.filters },
              steps: [base],
            },
          ]),
    ],
  });
}

/** A pull_request_review delivery with review.content set directly, standing in for
 * what enrichment.ts's merge produces. */
function reviewEvent(content: string): NormalizedForgejoEvent {
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
      sender: { login: "trillian" },
    },
  };
}

/** A pull_request delivery whose action is "review_requested". Forgejo raises this
 * under the plain pull_request header, unlike an approved or rejected review. */
function reviewRequestedEvent(): NormalizedForgejoEvent {
  return {
    id: "delivery-review-requested-1",
    type: "pull_request",
    repo: "acme/widgets",
    repositoryId: 1,
    connectionId: CONNECTION_ID,
    createdAt: "2026-09-25T12:06:00.000Z",
    payload: {
      action: "review_requested",
      number: 2,
      pull_request: { number: 2, title: "Add the widget", body: "", user: { login: "zaphod" } },
      requested_reviewer: { login: "trillian" },
      repository: { id: 1, full_name: "acme/widgets" },
      sender: { login: "zaphod" },
    },
  };
}

/** A push to a tag, standing in for what a real capture would carry (no fixture exists). */
function tagPushEvent(): NormalizedForgejoEvent {
  return {
    id: "delivery-tag-push-1",
    type: "push",
    repo: "acme/widgets",
    repositoryId: 1,
    connectionId: CONNECTION_ID,
    createdAt: "2026-09-25T12:07:00.000Z",
    payload: {
      ref: "refs/tags/v1.0.0",
      repository: { id: 1, full_name: "acme/widgets" },
      sender: { login: "trillian" },
    },
  };
}

/** Build a NormalizedForgejoEvent from a captured delivery, the way webhook.ts does. */
function forgejoEvent(
  name: string,
  enrichment?: { addedLabels?: string[]; addedAssignees?: string[] },
): NormalizedForgejoEvent {
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
    createdAt: "2026-09-25T08:00:00.000Z",
    payload,
    ...(enrichment?.addedLabels === undefined ? {} : { addedLabels: enrichment.addedLabels }),
    ...(enrichment?.addedAssignees === undefined
      ? {}
      : { addedAssignees: enrichment.addedAssignees }),
  };
}
