import { z } from "zod";
import { classifyForgeEvent, classifyPullRequest } from "../forge/classification.js";
import type { ForgeClassifiedEvent } from "../forge/classification.js";

/**
 * Issues, pull requests and comments read through the shared classifier, since
 * Forgejo spells them like GitHub. Reviews and label/assignee changes don't:
 *
 * | | GitHub | Forgejo |
 * | --- | --- | --- |
 * | review action | `submitted` | `reviewed` |
 * | changes requested | `changes_requested` | `pull_request_review_rejected` (`review.type`) |
 * | review object | `review.state` | `{type, content}` |
 * | label add | `action: "labeled"`, `label` field | `action: "label_updated"`, no `label` field |
 * | assign | `action: "assigned"`, `assignee` field | `action: "assigned"`, no single-assignee field |
 *
 * Forgejo's body says nothing about which label/assignee changed, only the current
 * list. enrichment.ts fills that gap from the issue timeline.
 */

const OptionalStringSchema = z.string().optional().catch(undefined);
const OptionalNumberSchema = z.number().optional().catch(undefined);

/** Forgejo sends GitHub-shaped bodies but no installation object; a connection
 * stands in for tenancy instead. */
export const ForgeWebhookPayloadSchema = z
  .object({
    repository: z
      .object({ id: OptionalNumberSchema, full_name: OptionalStringSchema })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

export type ForgeWebhookPayload = z.infer<typeof ForgeWebhookPayloadSchema>;

/** What every forge event carries. Tenancy is added per provider on top of this. */
export interface ForgeEventIdentity {
  readonly repo: string;
  readonly repositoryId: number;
  readonly payload: ForgeWebhookPayload;
}

/** An action_run_failure/action_run_success delivery has no top-level repository;
 * it lives one level down at run.repository. */
const ActionRunRepositoryPayloadSchema = z
  .object({
    run: z
      .object({
        repository: z
          .object({ id: OptionalNumberSchema, full_name: OptionalStringSchema })
          .passthrough()
          .optional()
          .catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

const FORGEJO_ACTION_RUN_EVENT_TYPES = new Set(["action_run_failure", "action_run_success"]);

/**
 * Read the repository a delivery is about. Returns undefined when the body names
 * none; webhook.ts logs that and answers 200 instead of rejecting.
 */
export function readForgeEventIdentity(
  payload: ForgeWebhookPayload,
  eventType: string,
): ForgeEventIdentity | undefined {
  const repository = FORGEJO_ACTION_RUN_EVENT_TYPES.has(eventType)
    ? ActionRunRepositoryPayloadSchema.safeParse(payload).data?.run?.repository
    : payload.repository;
  const repo = repository?.full_name;
  const repositoryId = repository?.id;

  if (typeof repo !== "string" || repo.length === 0) return undefined;
  // must be positive: the normalized event schema requires it, so a 0 or fraction
  // here would throw later at match time instead.
  if (typeof repositoryId !== "number" || !Number.isInteger(repositoryId) || repositoryId <= 0) {
    return undefined;
  }

  return { repo, repositoryId, payload };
}

export const FORGEJO_SEMANTIC_TRIGGER_EVENT_NAMES = [
  "forgejo.issue_created",
  "forgejo.pull_request_created",
  "forgejo.issue_comment_created",
  "forgejo.pull_request_comment_created",
  "forgejo.issue_label_added",
  "forgejo.pull_request_label_added",
  "forgejo.issue_assigned",
  "forgejo.pull_request_assigned",
  "forgejo.pull_request_review_approved",
  "forgejo.pull_request_review_rejected",
  "forgejo.pull_request_review_requested",
  "forgejo.issue_closed",
  "forgejo.issue_reopened",
  "forgejo.pull_request_closed",
  "forgejo.pull_request_merged",
  "forgejo.pull_request_reopened",
  "forgejo.pull_request_synchronized",
  "forgejo.action_run_failure",
  "forgejo.action_run_success",
] as const;

export type ForgejoSemanticEvent = (typeof FORGEJO_SEMANTIC_TRIGGER_EVENT_NAMES)[number];

export const FORGEJO_TRIGGER_SOURCE_NAMES = [
  "forgejo.issue_comment",
  "forgejo.issues",
  "forgejo.pull_request",
  "forgejo.pull_request_review",
  "forgejo.push",
  // Forgejo already spells the outcome into the wire event name, so raw source and
  // semantic event are the same string here. Still listed in both places since
  // workflows/engine.ts routes by source name before match() runs.
  "forgejo.action_run_failure",
  "forgejo.action_run_success",
] as const;

export const NormalizedForgejoEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  repo: z.string(),
  repositoryId: z.number().int().positive(),
  /** Tenancy key. Forgejo has no installation, so the connection stands in for one. */
  connectionId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  /** Logins/names added by this delivery, read off the issue timeline. See enrichment.ts. */
  addedLabels: z.array(z.string()).optional(),
  addedAssignees: z.array(z.string()).optional(),
});

/** A Forgejo delivery, resolved to its tenant and repository. */
export interface NormalizedForgejoEvent {
  id: string;
  type: string;
  repo: string;
  repositoryId: number;
  connectionId: string;
  payload: ForgeWebhookPayload;
  createdAt: string;
  addedLabels?: readonly string[] | undefined;
  addedAssignees?: readonly string[] | undefined;
}

export interface ForgejoClassifiedEvent extends Omit<ForgeClassifiedEvent, "semanticEvent"> {
  readonly semanticEvent: ForgejoSemanticEvent | undefined;
  /** Empty unless enrichment ran and found something; see `NormalizedForgejoEvent.addedLabels`. */
  readonly addedLabels: readonly string[];
  readonly addedAssignees: readonly string[];
  /** From a review_requested/_removed delivery's own requested_reviewer field. Needs
   * no enrichment lookup, unlike a label or assignee. */
  readonly requestedReviewer: string | undefined;
}

/** Reviews arrive as action: "reviewed" with the verdict in review.type, not GitHub's
 * submitted + review.state. _comment raises no semantic event, matching GitHub's gap
 * for a plain submission. */
const ForgejoReviewPayloadSchema = z
  .object({
    action: z.string().optional().catch(undefined),
    review: z
      .object({
        type: z.string().optional().catch(undefined),
        content: z.string().optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
    sender: z
      .object({ login: z.string().optional().catch(undefined) })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

const ForgejoActionSchema = z
  .object({ action: z.string().optional().catch(undefined) })
  .passthrough();

const ForgejoRequestedReviewerSchema = z
  .object({
    requested_reviewer: z
      .object({ login: z.string().optional().catch(undefined) })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

function readRequestedReviewer(payload: unknown): string | undefined {
  return ForgejoRequestedReviewerSchema.safeParse(payload).data?.requested_reviewer?.login;
}

/** Whether a closed pull request delivery is a merge or a plain close. Both stamp
 * action: "closed"; pull_request.merged is the only field that tells them apart. */
const ForgejoPullRequestMergedSchema = z
  .object({
    pull_request: z
      .object({ merged: z.boolean().optional().catch(undefined) })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

export function classifyForgejoEvent(event: {
  type: string;
  payload: unknown;
  addedLabels?: readonly string[] | undefined;
  addedAssignees?: readonly string[] | undefined;
}): ForgejoClassifiedEvent {
  const addedLabels = event.addedLabels ?? [];
  const addedAssignees = event.addedAssignees ?? [];
  const requestedReviewer = readRequestedReviewer(event.payload);

  if (event.type === "pull_request_review") {
    return {
      ...classifyForgejoReview(event.payload),
      addedLabels,
      addedAssignees,
      requestedReviewer,
    };
  }

  if (event.type === "action_run_failure" || event.type === "action_run_success") {
    return {
      ...classifyForgejoActionRun(event.type, event.payload),
      addedLabels,
      addedAssignees,
      requestedReviewer,
    };
  }

  const classified = classifyForgeEvent(event);
  return {
    ...classified,
    semanticEvent: forgejoSemanticEvent(event, addedLabels, addedAssignees, classified),
    addedLabels,
    addedAssignees,
    requestedReviewer,
  };
}

/** Forgejo's action spellings never match GitHub's, so the shared classifier's
 * semantic event is always undefined for label/assignee changes; this raises them. */
function forgejoSemanticEvent(
  event: { type: string; payload: unknown },
  addedLabels: readonly string[],
  addedAssignees: readonly string[],
  classified: ForgeClassifiedEvent,
): ForgejoSemanticEvent | undefined {
  const action = ForgejoActionSchema.safeParse(event.payload).data?.action;
  let bespoke: ForgejoSemanticEvent | undefined;
  if (event.type === "issues") {
    bespoke = forgejoIssuesSemanticEvent(action, addedLabels, addedAssignees);
  } else if (event.type === "pull_request") {
    bespoke = forgejoPullRequestSemanticEvent(action, addedLabels, addedAssignees, event.payload);
  }
  if (bespoke !== undefined) return bespoke;
  return classified.semanticEvent === undefined ? undefined : `forgejo.${classified.semanticEvent}`;
}

function forgejoIssuesSemanticEvent(
  action: string | undefined,
  addedLabels: readonly string[],
  addedAssignees: readonly string[],
): ForgejoSemanticEvent | undefined {
  if (action === "label_updated" && addedLabels.length > 0) return "forgejo.issue_label_added";
  if (action === "assigned" && addedAssignees.length > 0) return "forgejo.issue_assigned";
  if (action === "closed") return "forgejo.issue_closed";
  if (action === "reopened") return "forgejo.issue_reopened";
  return undefined;
}

function forgejoPullRequestSemanticEvent(
  action: string | undefined,
  addedLabels: readonly string[],
  addedAssignees: readonly string[],
  payload: unknown,
): ForgejoSemanticEvent | undefined {
  if (action === "label_updated" && addedLabels.length > 0) {
    return "forgejo.pull_request_label_added";
  }
  if (action === "assigned" && addedAssignees.length > 0) return "forgejo.pull_request_assigned";
  if (action === "review_requested") return "forgejo.pull_request_review_requested";
  if (action === "synchronized") return "forgejo.pull_request_synchronized";
  if (action === "reopened") return "forgejo.pull_request_reopened";
  if (action === "closed") {
    const merged = ForgejoPullRequestMergedSchema.safeParse(payload).data?.pull_request?.merged;
    return merged === true ? "forgejo.pull_request_merged" : "forgejo.pull_request_closed";
  }
  return undefined;
}

const ForgejoActionRunPayloadSchema = z
  .object({
    /** prior_status is this same run's status right before it finished (always
     * pending: running/waiting/blocked/unknown), never "failure". So it can't tell a
     * genuine recovery from a first-time success, and there's no
     * forgejo.action_run_recover event here as a result. */
    prior_status: z.string().optional().catch(undefined),
    run: z
      .object({
        trigger_user: z
          .object({ login: z.string().optional().catch(undefined) })
          .passthrough()
          .optional()
          .catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

/** action_run_failure also covers a cancelled or skipped run, not only an actual test
 * failure. No bespoke event for those; an author reads ci_run.status off the agent
 * context instead (see provider.ts). */
function classifyForgejoActionRun(
  eventType: "action_run_failure" | "action_run_success",
  payload: unknown,
): Omit<ForgejoClassifiedEvent, "addedLabels" | "addedAssignees" | "requestedReviewer"> {
  const parsed = ForgejoActionRunPayloadSchema.parse(payload);
  return {
    semanticEvent:
      eventType === "action_run_failure"
        ? "forgejo.action_run_failure"
        : "forgejo.action_run_success",
    actor: parsed.run?.trigger_user?.login ?? "",
    text: "",
    labels: [],
    changedLabel: undefined,
    item: null,
  };
}

function classifyForgejoReview(
  payload: unknown,
): Omit<ForgejoClassifiedEvent, "addedLabels" | "addedAssignees" | "requestedReviewer"> {
  const parsed = ForgejoReviewPayloadSchema.parse(payload);
  // the review's pull_request object is spelled like any other pull request event,
  // so reuse that reader instead of a second copy.
  const pullRequest = classifyPullRequest(payload);
  return {
    ...pullRequest,
    semanticEvent: forgejoReviewSemanticEvent(parsed.review?.type),
    text: parsed.review?.content ?? "",
  };
}

/** A comment-only review's verdict is pull_request_review_comment, which raises no
 * semantic event. */
function forgejoReviewSemanticEvent(
  reviewType: string | undefined,
): ForgejoSemanticEvent | undefined {
  if (reviewType === "pull_request_review_approved") return "forgejo.pull_request_review_approved";
  if (reviewType === "pull_request_review_rejected") return "forgejo.pull_request_review_rejected";
  return undefined;
}

/** Review deliveries arrive under these three headers. Normalizing them to
 * pull_request_review lets a trigger name the one documented source. */
const FORGEJO_REVIEW_EVENT_TYPES = new Set([
  "pull_request_approved",
  "pull_request_rejected",
  "pull_request_comment",
]);

export function normalizeForgejoEventType(eventType: string): string {
  return FORGEJO_REVIEW_EVENT_TYPES.has(eventType) ? "pull_request_review" : eventType;
}

export function forgejoSourceName(eventType: string): string {
  return `forgejo.${eventType}`;
}
