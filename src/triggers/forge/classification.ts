import { z } from "zod";
import {
  IssueCommentPayloadSchema,
  IssuesPayloadSchema,
  PullRequestPayloadSchema,
} from "./payload-schemas.js";

/**
 * Forgejo reproduces GitHub's issue/pull_request/comment payload shape, so these
 * readers work unchanged on both. Reviews are not here: the forges disagree about
 * them, so each provider classifies its own review reader and reuses
 * classifyPullRequest below for the item/labels.
 */

/** Semantic events both forges can raise, without the provider prefix. */
export const FORGE_SEMANTIC_EVENT_SUFFIXES = [
  "issue_created",
  "pull_request_created",
  "issue_comment_created",
  "pull_request_comment_created",
  "issue_label_added",
  "pull_request_label_added",
] as const;

export type ForgeSemanticEventSuffix = (typeof FORGE_SEMANTIC_EVENT_SUFFIXES)[number];

export interface ForgeClassifiedItem {
  readonly type: "issue" | "pull_request";
  readonly number: number | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly url: string | null;
  readonly author: { readonly login: string } | null;
}

export interface ForgeClassifiedEvent {
  readonly semanticEvent: ForgeSemanticEventSuffix | undefined;
  readonly actor: string;
  readonly text: string;
  readonly labels: readonly string[];
  readonly changedLabel: string | undefined;
  readonly item: ForgeClassifiedItem | null;
}

export function classifyForgeEvent(input: {
  type: string;
  payload: unknown;
}): ForgeClassifiedEvent {
  if (input.type === "issues") return classifyIssue(input.payload);
  if (input.type === "pull_request") return classifyPullRequest(input.payload);
  if (input.type === "issue_comment") return classifyIssueComment(input.payload);
  if (input.type === "push") return classifyPush(input.payload);
  return emptyForgeClassification();
}

const PushSenderPayloadSchema = z
  .object({
    sender: z
      .object({ login: z.string().optional().catch(undefined) })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

/** A push carries no issue or comment, only who did it, so `from_users` is the only filter that applies. */
function classifyPush(payload: unknown): ForgeClassifiedEvent {
  const parsed = PushSenderPayloadSchema.parse(payload);
  return { ...emptyForgeClassification(), actor: parsed.sender?.login ?? "" };
}

export function emptyForgeClassification(): ForgeClassifiedEvent {
  return {
    semanticEvent: undefined,
    actor: "",
    text: "",
    labels: [],
    changedLabel: undefined,
    item: null,
  };
}

function classifyIssue(payload: unknown): ForgeClassifiedEvent {
  const parsed = IssuesPayloadSchema.parse(payload);
  const item = parsed.issue === undefined ? null : itemFor("issue", parsed.issue);
  return {
    semanticEvent: issueSemanticEvent(parsed.action),
    actor: parsed.sender?.login ?? "",
    text: textFor(item),
    labels: labelsFor(parsed.issue?.labels),
    changedLabel: parsed.action === "labeled" ? parsed.label?.name : undefined,
    item,
  };
}

/** Exported so a review payload's `pull_request` object can reuse this instead of duplicating it. */
export function classifyPullRequest(payload: unknown): ForgeClassifiedEvent {
  const parsed = PullRequestPayloadSchema.parse(payload);
  const item =
    parsed.pull_request === undefined ? null : itemFor("pull_request", parsed.pull_request);
  return {
    semanticEvent: pullRequestSemanticEvent(parsed.action),
    actor: parsed.sender?.login ?? "",
    text: textFor(item),
    labels: labelsFor(parsed.pull_request?.labels),
    changedLabel: parsed.action === "labeled" ? parsed.label?.name : undefined,
    item,
  };
}

function classifyIssueComment(payload: unknown): ForgeClassifiedEvent {
  const parsed = IssueCommentPayloadSchema.parse(payload);
  const isPullRequest = parsed.issue?.pull_request !== undefined;
  return {
    semanticEvent: commentSemanticEvent(parsed.action, isPullRequest),
    actor: parsed.sender?.login ?? parsed.comment?.user?.login ?? "",
    text: parsed.comment?.body ?? "",
    labels: labelsFor(parsed.issue?.labels),
    changedLabel: undefined,
    item:
      parsed.issue === undefined
        ? null
        : itemFor(isPullRequest ? "pull_request" : "issue", parsed.issue),
  };
}

function issueSemanticEvent(action: string | undefined): ForgeSemanticEventSuffix | undefined {
  if (action === "opened") return "issue_created";
  if (action === "labeled") return "issue_label_added";
  return undefined;
}

function pullRequestSemanticEvent(
  action: string | undefined,
): ForgeSemanticEventSuffix | undefined {
  if (action === "opened") return "pull_request_created";
  if (action === "labeled") return "pull_request_label_added";
  return undefined;
}

function commentSemanticEvent(
  action: string | undefined,
  isPullRequest: boolean,
): ForgeSemanticEventSuffix | undefined {
  if (action !== "created") return undefined;
  return isPullRequest ? "pull_request_comment_created" : "issue_comment_created";
}

function itemFor(
  type: ForgeClassifiedItem["type"],
  item: {
    number?: number | undefined;
    title?: string | undefined;
    body?: string | undefined;
    html_url?: string | undefined;
    user?: { login?: string | undefined } | undefined;
  },
): ForgeClassifiedItem {
  return {
    type,
    number: item.number ?? null,
    title: item.title ?? null,
    body: item.body ?? null,
    url: item.html_url ?? null,
    author: item.user?.login === undefined ? null : { login: item.user.login },
  };
}

function textFor(item: ForgeClassifiedItem | null): string {
  return [item?.title ?? "", item?.body ?? ""].filter((value) => value.length > 0).join("\n");
}

/** Every current label's name, dropping the unnamed ones. */
export function labelsFor(
  labels: readonly { name?: string | undefined }[] | undefined,
): readonly string[] {
  return labels?.flatMap((label) => (label.name === undefined ? [] : [label.name])) ?? [];
}
