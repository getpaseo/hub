import { z } from "zod";
import type { ForgejoReviewComment, ForgejoTimelineEntry } from "./client.js";

// wire shapes client.ts's call() parses a forgejo response into, and mappers for the
// ones with a nontrivial shape. split out purely to keep client.ts down to the client
// itself, nothing here is meant to be used outside it.

// the body every non-ok forgejo response answers with: {message, url}, only message is read
export const ApiErrorBodySchema = z.object({ message: z.string().min(1) }).passthrough();

export const CommentSchema = z.object({ id: z.number() }).passthrough();
export const UserSchema = z.object({ id: z.number(), login: z.string().min(1) }).passthrough();
export const RepositorySchema = z
  .object({ id: z.number(), full_name: z.string().min(1) })
  .passthrough();
export const OrgSchema = z.object({ username: z.string().min(1) }).passthrough();
// body GET /version answers with, unauthenticated: {version}
export const VersionSchema = z.object({ version: z.string().min(1) }).passthrough();
export const HookSchema = z
  .object({
    id: z.number(),
    active: z.boolean().optional().catch(undefined),
    events: z.array(z.string()).optional().catch(undefined),
    config: z
      .object({ url: z.string().optional().catch(undefined) })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

export const ReviewSchema = z
  .object({
    id: z.number(),
    user: z
      .object({ login: z.string().optional().catch(undefined) })
      .passthrough()
      .nullable()
      .optional()
      .catch(undefined),
    // APPROVED, PENDING, COMMENT, REQUEST_CHANGES, REQUEST_REVIEW, or "". tells a
    // submitted review apart from a still-open draft or a never-submitted request.
    state: z.string().optional().catch(undefined),
    submitted_at: z.string().optional().catch(undefined),
    updated_at: z.string().optional().catch(undefined),
    body: z.string().optional().catch(undefined),
  })
  .passthrough();

export const ReviewCommentSchema = z
  .object({
    id: z.number(),
    body: z.string().optional().catch(undefined),
    path: z.string().optional().catch(undefined),
    commit_id: z.string().optional().catch(undefined),
    diff_hunk: z.string().optional().catch(undefined),
    // forgejo reports a single line as whichever of these two is nonzero: position for
    // a new/right-side line, original_position for an old/left-side one. see mapReviewComment.
    position: z.number().optional().catch(undefined),
    original_position: z.number().optional().catch(undefined),
    html_url: z.string().optional().catch(undefined),
    created_at: z.string().optional().catch(undefined),
    user: z
      .object({ login: z.string().optional().catch(undefined) })
      .passthrough()
      .nullable()
      .optional()
      .catch(undefined),
  })
  .passthrough();

export const TimelineEntrySchema = z
  .object({
    id: z.number().optional().catch(undefined),
    type: z.string(),
    body: z.string().optional().catch(undefined),
    created_at: z.string().optional().catch(undefined),
    user: z
      .object({ login: z.string().optional().catch(undefined) })
      .passthrough()
      .nullable()
      .optional()
      .catch(undefined),
    label: z
      .object({ name: z.string().optional().catch(undefined) })
      .passthrough()
      .nullable()
      .optional()
      .catch(undefined),
    assignee: z
      .object({ login: z.string().optional().catch(undefined) })
      .passthrough()
      .nullable()
      .optional()
      .catch(undefined),
    removed_assignee: z.boolean().optional().catch(undefined),
  })
  .passthrough();

// a 0 line number is forgejo's zero value for "not this side", not a real line 0
// (lines are 1-based), so it maps to undefined same as a genuinely absent field
export function mapReviewComment(
  comment: z.infer<typeof ReviewCommentSchema>,
): ForgejoReviewComment {
  const rightLine =
    comment.position === undefined || comment.position === 0 ? undefined : comment.position;
  const leftLine =
    comment.original_position === undefined || comment.original_position === 0
      ? undefined
      : comment.original_position;
  const side = reviewCommentSide(rightLine, leftLine);
  return {
    id: comment.id,
    body: comment.body ?? "",
    path: comment.path,
    line: rightLine ?? leftLine,
    side,
    diffHunk: comment.diff_hunk,
    commitId: comment.commit_id,
    htmlUrl: comment.html_url,
    userLogin: comment.user?.login ?? undefined,
    createdAt: comment.created_at,
  };
}

function reviewCommentSide(
  rightLine: number | undefined,
  leftLine: number | undefined,
): "LEFT" | "RIGHT" | undefined {
  if (rightLine !== undefined) return "RIGHT";
  if (leftLine !== undefined) return "LEFT";
  return undefined;
}

export function mapTimelineEntry(entry: z.infer<typeof TimelineEntrySchema>): ForgejoTimelineEntry {
  return {
    id: entry.id,
    type: entry.type,
    body: entry.body,
    createdAtMs: parseInstant(entry.created_at),
    userLogin: entry.user?.login ?? undefined,
    labelName: entry.label?.name ?? undefined,
    assigneeLogin: entry.assignee?.login ?? undefined,
    removedAssignee: entry.removed_assignee === true,
  };
}

// forgejo timestamps carry the instance's own server-local offset, never necessarily Z,
// so parsing to epoch ms here lets callers compare real instants instead of comparing
// text, which silently gets the wrong answer whenever the offset is nonzero
export function parseInstant(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.getTime();
}
