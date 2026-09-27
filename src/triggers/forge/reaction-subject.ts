import {
  IssueCommentPayloadSchema,
  IssuesPayloadSchema,
  PullRequestPayloadSchema,
} from "./payload-schemas.js";

/**
 * Where a reaction attaches: the item for issue/pull_request, its comment for
 * issue_comment. GitHub has a fourth kind, pull_request_review_comment, that Forgejo
 * has no separate webhook event for, so that one stays in github/provider.ts.
 */
export type ForgeItemReactionSubject =
  | { kind: "item"; issueNumber: number }
  | { kind: "issue_comment"; commentId: number };

export function forgeItemReactionSubjectForEvent(event: {
  type: string;
  payload: unknown;
}): ForgeItemReactionSubject | null {
  if (event.type === "issues") {
    const payload = IssuesPayloadSchema.parse(event.payload);
    return payload.issue?.number === undefined
      ? null
      : { kind: "item", issueNumber: payload.issue.number };
  }

  if (event.type === "pull_request") {
    const payload = PullRequestPayloadSchema.parse(event.payload);
    return payload.pull_request?.number === undefined
      ? null
      : { kind: "item", issueNumber: payload.pull_request.number };
  }

  if (event.type === "issue_comment") {
    const payload = IssueCommentPayloadSchema.parse(event.payload);
    return payload.comment?.id === undefined
      ? null
      : { kind: "issue_comment", commentId: payload.comment.id };
  }

  return null;
}
