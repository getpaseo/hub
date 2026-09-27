import { z } from "zod";
import { logger } from "../../logger.js";
import {
  ApiErrorBodySchema,
  CommentSchema,
  HookSchema,
  OrgSchema,
  RepositorySchema,
  ReviewCommentSchema,
  ReviewSchema,
  TimelineEntrySchema,
  UserSchema,
  VersionSchema,
  mapReviewComment,
  mapTimelineEntry,
  parseInstant,
} from "./api-schemas.js";
import { createGuardedForgejoFetch } from "./guarded-fetch.js";
import {
  readAllowedPrivateHostsFromEnv,
  type ForgejoAllowedPrivateHosts,
} from "./instance-guard.js";
import { apiUrl } from "./instance-url.js";

// every instance serves the same surface under /api/v1 on its own host: no separate
// api. domain, no app, and auth uses "Authorization: token <t>" instead of Bearer

export interface ForgejoCredentials {
  instanceBaseUrl: string;
  accessToken: string;
}

export interface ForgejoTimelineEntry {
  id: number | undefined;
  type: string;
  body: string | undefined;
  // epoch ms, parsed from forgejo's created_at: the instance serializes it in its own
  // server timezone, so comparing two of these as raw strings breaks on non-utc instances
  createdAtMs: number | undefined;
  userLogin: string | undefined;
  labelName: string | undefined;
  assigneeLogin: string | undefined;
  removedAssignee: boolean;
}

// one review submitted on a pull request, as the listing api returns it
export interface ForgejoReviewSummary {
  id: number;
  userLogin: string | undefined;
  state: string | undefined;
  // when the review was first created (opened as a draft), not submitted; updatedAtMs moves on submit
  submittedAtMs: number | undefined;
  updatedAtMs: number | undefined;
  body: string | undefined;
}

// line/side are named for what forgejo actually reports, not github's line/original_line:
// forgejo signs a single line number on whichever side the comment is on (position for
// the new side, original_position for the old), see services/convert/pull_review.go
export interface ForgejoReviewComment {
  id: number;
  body: string;
  path: string | undefined;
  line: number | undefined;
  side: "LEFT" | "RIGHT" | undefined;
  diffHunk: string | undefined;
  commitId: string | undefined;
  htmlUrl: string | undefined;
  userLogin: string | undefined;
  createdAt: string | undefined;
}

// forgejo has no reaction id, the delete endpoint takes the same content string back;
// a reaction is keyed by (issue or comment, doer, type)
export type ForgejoReactionContent = "+1" | "-1" | "eyes";

// forgejo has no separate review-comment reaction endpoint like github: every comment,
// including one on a pull request review, is an issue comment through the same path
export type ForgejoReactionSubject =
  | { kind: "item"; issueNumber: number }
  | { kind: "issue_comment"; commentId: number };

/** A user's own webhooks, or one organization's, chosen by whose the token may manage. */
export type ForgejoHookTarget = { scope: "user" } | { scope: "org"; org: string };

/** One webhook as the instance reports it back; only what subscribe's idempotency check needs. */
export interface ForgejoHookSummary {
  id: number;
  url: string | undefined;
  active: boolean | undefined;
  events: readonly string[] | undefined;
}

export interface ForgejoApiClient {
  createIssueComment(input: {
    credentials: ForgejoCredentials;
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<{ id: number }>;
  // forgejo has no bot account, so this is a real user; id is stable across a rename, login is not
  readViewer(credentials: ForgejoCredentials): Promise<{ login: string; id: number }>;
  readVersion(credentials: ForgejoCredentials): Promise<{ version: string }>;
  // undefined for a 404 only; every other failure is a thrown ForgejoApiError, not "not found"
  getRepository(
    credentials: ForgejoCredentials,
    owner: string,
    repo: string,
  ): Promise<{ id: number; fullName: string } | undefined>;
  // since is an advisory bound (RFC3339), not a correctness requirement
  listIssueTimeline(input: {
    credentials: ForgejoCredentials;
    owner: string;
    repo: string;
    issueNumber: number;
    since?: string;
    limit?: number;
    signal?: AbortSignal | undefined;
  }): Promise<ForgejoTimelineEntry[]>;
  // a review delivery's webhook body carries no review id, so enrichment lists these and
  // picks the one a delivery is about by sender login and submission time
  listPullReviews(input: {
    credentials: ForgejoCredentials;
    owner: string;
    repo: string;
    issueNumber: number;
    signal?: AbortSignal | undefined;
  }): Promise<ForgejoReviewSummary[]>;
  // recovers text for a review whose content arrived empty, which forgejo does for a
  // review made up only of inline comments
  listPullReviewComments(input: {
    credentials: ForgejoCredentials;
    owner: string;
    repo: string;
    issueNumber: number;
    reviewId: number;
    signal?: AbortSignal | undefined;
  }): Promise<ForgejoReviewComment[]>;
  listMyOrgs(credentials: ForgejoCredentials): Promise<{ username: string }[]>;
  listHooks(
    credentials: ForgejoCredentials,
    target: ForgejoHookTarget,
  ): Promise<ForgejoHookSummary[]>;
  createHook(
    credentials: ForgejoCredentials,
    target: ForgejoHookTarget,
    input: { url: string; secret: string; events: readonly string[] },
  ): Promise<{ id: number }>;
  deleteHook(
    credentials: ForgejoCredentials,
    target: ForgejoHookTarget,
    hookId: number,
  ): Promise<void>;
  // forgejo answers an already-existing reaction with 200, not an error, so safe to call again
  createReaction(input: {
    credentials: ForgejoCredentials;
    owner: string;
    repo: string;
    subject: ForgejoReactionSubject;
    content: ForgejoReactionContent;
  }): Promise<void>;
  deleteReaction(input: {
    credentials: ForgejoCredentials;
    owner: string;
    repo: string;
    subject: ForgejoReactionSubject;
    content: ForgejoReactionContent;
  }): Promise<void>;
}

export class ForgejoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    // the instance's own error message, when its body carried one; undefined if the body
    // was empty, not json, or over the size cap
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ForgejoApiError";
  }
}

// status is the redirect's own status, so callers can instanceof this apart from an
// ordinary refusal to tell an operator "that address redirected" vs "refused the token"
export class ForgejoRedirectRefusedError extends ForgejoApiError {
  constructor(status: number) {
    super(status, `forgejo instance redirected the request; hub does not follow it: ${status}`);
    this.name = "ForgejoRedirectRefusedError";
  }
}

// status is the response's own 2xx status; the instance answered normally, the body was
// just too big to trust into memory
export class ForgejoResponseTooLargeError extends ForgejoApiError {
  constructor(status: number, limitBytes: number) {
    super(status, `forgejo response exceeded ${limitBytes} bytes, refused before parsing`);
    this.name = "ForgejoResponseTooLargeError";
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
// these cap the worst case instead of paging forever
const MAX_TIMELINE_PAGES = 10;
const MAX_HOOK_PAGES = 10;
const MAX_ORG_PAGES = 10;
const MAX_REVIEW_PAGES = 10;

// fetch every page until an empty page ends it. a page shorter than the requested limit
// is not proof there's no more: forgejo silently clamps limit to its own configured
// MAX_RESPONSE_ITEMS (modules/setting/api.go), so only an empty page is trustworthy.
// X-Total-Count isn't used either: the issue timeline handler sets it to the current
// page's post-filter length, not a true total, so page one would look complete.
// idOf guards against an endpoint that ignores page/limit and hands back its whole
// corpus every time: if a page's ids exactly match the previous page's, stop instead
// of duplicating every entry forever.
async function fetchAllPages<T>(
  maxPages: number,
  onCapped: () => void,
  fetchPage: (page: number) => Promise<T[]>,
  idOf?: (item: T) => unknown,
): Promise<T[]> {
  const items: T[] = [];
  let previousIds: unknown[] | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const pageItems = await fetchPage(page);
    if (pageItems.length === 0) return items;
    if (idOf !== undefined) {
      const ids = pageItems.map(idOf);
      if (previousIds !== undefined && sameIds(previousIds, ids)) return items;
      previousIds = ids;
    }
    items.push(...pageItems);
    if (page === maxPages) onCapped();
  }
  return items;
}

function sameIds(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// keeps every element that matches schema, skipping only the ones that don't, rather
// than z.array(schema).catch([]) discarding the whole page over one malformed element
// (fetchAllPages would then read that empty page as the end of the listing)
function parseListPage<T>(schema: z.ZodType<T>, raw: unknown, endpoint: string): T[] {
  if (!Array.isArray(raw)) return [];
  const items: T[] = [];
  for (const element of raw) {
    const parsed = schema.safeParse(element);
    if (parsed.success) {
      items.push(parsed.data);
    } else {
      logger.warn(
        { endpoint, issues: parsed.error.issues },
        "forgejo skipped a malformed list element",
      );
    }
  }
  return items;
}

// response.json() has no size limit of its own, so read the stream by hand and count
// bytes as they arrive, bailing out (and cancelling the rest) before buffering too much
async function readJsonBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return response.json();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ForgejoResponseTooLargeError(response.status, MAX_RESPONSE_BYTES);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

// a body that is empty, not json, or over the size cap yields undefined, not a throw
async function readErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const parsed = ApiErrorBodySchema.safeParse(await readJsonBody(response));
    return parsed.success ? parsed.data.message : undefined;
  } catch {
    return undefined;
  }
}

/** Every hook create/list/delete call hangs off one of these two roots. */
function hookTargetPath(target: ForgejoHookTarget): string {
  return target.scope === "user" ? "/user/hooks" : `/orgs/${segment(target.org)}/hooks`;
}

export function createForgejoApiClient(
  options: {
    fetch?: typeof fetch;
    allowedPrivateHosts?: ForgejoAllowedPrivateHosts;
  } = {},
): ForgejoApiClient {
  const request =
    options.fetch ??
    createGuardedForgejoFetch(options.allowedPrivateHosts ?? readAllowedPrivateHostsFromEnv());

  async function call(
    credentials: ForgejoCredentials,
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      parseResponse?: boolean;
      signal?: AbortSignal | undefined;
    },
  ): Promise<unknown> {
    const response = await request(apiUrl(credentials.instanceBaseUrl, path), {
      method: init?.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `token ${credentials.accessToken}`,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      // never follow a redirect: the guard above only checked the stored/submitted host,
      // and a redirect is a way to dial a different one it never checked
      redirect: "manual",
      // a caller's own signal (the webhook's enrichment deadline) can cut it short too
      signal:
        init?.signal === undefined
          ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          : AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new ForgejoRedirectRefusedError(response.status);
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new ForgejoApiError(
        response.status,
        detail === undefined
          ? `forgejo request failed: ${response.status}`
          : `forgejo request failed: ${response.status}: ${detail}`,
        detail,
      );
    }
    // a caller that doesn't need the body (a reaction delete's 200 has none either) says
    // so explicitly instead of guessing from the status code alone
    if (init?.parseResponse === false) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    if (response.status === 204) return undefined;
    return readJsonBody(response);
  }

  return {
    async createIssueComment({ credentials, owner, repo, issueNumber, body }) {
      const created = await call(
        credentials,
        `/repos/${segment(owner)}/${segment(repo)}/issues/${issueNumber}/comments`,
        { method: "POST", body: { body } },
      );
      return { id: CommentSchema.parse(created).id };
    },
    async readViewer(credentials) {
      const viewer = UserSchema.parse(await call(credentials, "/user"));
      return { login: viewer.login, id: viewer.id };
    },
    async readVersion(credentials) {
      const version = VersionSchema.parse(await call(credentials, "/version"));
      return { version: version.version };
    },
    async getRepository(credentials, owner, repo) {
      try {
        const raw = await call(credentials, `/repos/${segment(owner)}/${segment(repo)}`);
        const found = RepositorySchema.parse(raw);
        return { id: found.id, fullName: found.full_name };
      } catch (error) {
        if (error instanceof ForgejoApiError && error.status === 404) return undefined;
        throw error;
      }
    },
    async listIssueTimeline({ credentials, owner, repo, issueNumber, since, limit, signal }) {
      const pageSize = limit ?? 50;
      return fetchAllPages(
        MAX_TIMELINE_PAGES,
        () =>
          logger.warn(
            { owner, repo, issueNumber, pages: MAX_TIMELINE_PAGES },
            "forgejo issue timeline pagination capped, later entries may be missing",
          ),
        async (page) => {
          const query = new URLSearchParams();
          if (since !== undefined) query.set("since", since);
          query.set("limit", String(pageSize));
          query.set("page", String(page));
          const raw = await call(
            credentials,
            `/repos/${segment(owner)}/${segment(repo)}/issues/${issueNumber}/timeline?${query.toString()}`,
            { signal },
          );
          return parseListPage(TimelineEntrySchema, raw, "issue_timeline").map(mapTimelineEntry);
        },
        (entry) => entry.id,
      );
    },
    async listPullReviews({ credentials, owner, repo, issueNumber, signal }) {
      return fetchAllPages(
        MAX_REVIEW_PAGES,
        () =>
          logger.warn(
            { owner, repo, issueNumber, pages: MAX_REVIEW_PAGES },
            "forgejo pull review pagination capped, later reviews may be missing",
          ),
        async (page) => {
          const query = new URLSearchParams({ limit: "50", page: String(page) });
          const raw = await call(
            credentials,
            `/repos/${segment(owner)}/${segment(repo)}/pulls/${issueNumber}/reviews?${query.toString()}`,
            { signal },
          );
          return parseListPage(ReviewSchema, raw, "pull_reviews").map((review) => ({
            id: review.id,
            userLogin: review.user?.login ?? undefined,
            state: review.state,
            submittedAtMs: parseInstant(review.submitted_at),
            updatedAtMs: parseInstant(review.updated_at),
            body: review.body,
          }));
        },
        (review) => review.id,
      );
    },
    async listPullReviewComments({ credentials, owner, repo, issueNumber, reviewId, signal }) {
      // un-paged: forgejo's GetPullReviewComments takes no page/limit and always
      // returns the review's whole comment list, so paging it would just duplicate it
      const raw = await call(
        credentials,
        `/repos/${segment(owner)}/${segment(repo)}/pulls/${issueNumber}/reviews/${reviewId}/comments`,
        { signal },
      );
      return parseListPage(ReviewCommentSchema, raw, "pull_review_comments").map(mapReviewComment);
    },
    async listMyOrgs(credentials) {
      return fetchAllPages(
        MAX_ORG_PAGES,
        () => logger.warn({ pages: MAX_ORG_PAGES }, "forgejo org listing pagination capped"),
        async (page) => {
          const query = new URLSearchParams({ limit: "50", page: String(page) });
          const raw = await call(credentials, `/user/orgs?${query.toString()}`);
          return parseListPage(OrgSchema, raw, "my_orgs").map((org) => ({
            username: org.username,
          }));
        },
        (org) => org.username,
      );
    },
    async listHooks(credentials, target) {
      const path = hookTargetPath(target);
      return fetchAllPages(
        MAX_HOOK_PAGES,
        () =>
          logger.warn({ target, pages: MAX_HOOK_PAGES }, "forgejo hook listing pagination capped"),
        async (page) => {
          const query = new URLSearchParams({ limit: "50", page: String(page) });
          const raw = await call(credentials, `${path}?${query.toString()}`);
          // a non-array body is not "no hooks", let it throw instead of tricking
          // subscribe's idempotency check into creating a second hook
          const parsed = z.array(HookSchema).parse(raw);
          return parsed.map((hook) => ({
            id: hook.id,
            url: hook.config?.url,
            active: hook.active,
            events: hook.events,
          }));
        },
        (hook) => hook.id,
      );
    },
    async createHook(credentials, target, input) {
      const created = await call(credentials, hookTargetPath(target), {
        method: "POST",
        body: {
          // "gitea", not "forgejo": a real gitea instance rejects the "forgejo" hook type
          // outright, while forgejo accepts both. the two only differ in how a create/delete
          // payload short-names the ref, and FORGEJO_HOOK_EVENTS never sends those, so
          // "gitea" is byte-identical to "forgejo" for every event Hub sends.
          type: "gitea",
          active: true,
          config: { url: input.url, content_type: "json", secret: input.secret },
          events: [...input.events],
        },
      });
      return { id: HookSchema.parse(created).id };
    },
    async deleteHook(credentials, target, hookId) {
      await call(credentials, `${hookTargetPath(target)}/${hookId}`, { method: "DELETE" });
    },
    async createReaction({ credentials, owner, repo, subject, content }) {
      await call(credentials, reactionPath(owner, repo, subject), {
        method: "POST",
        body: { content },
        parseResponse: false,
      });
    },
    async deleteReaction({ credentials, owner, repo, subject, content }) {
      await call(credentials, reactionPath(owner, repo, subject), {
        method: "DELETE",
        body: { content },
        parseResponse: false,
      });
    },
  };
}

/** Every reaction create/delete call hangs off one of these two roots. */
function reactionPath(owner: string, repo: string, subject: ForgejoReactionSubject): string {
  const base = `/repos/${segment(owner)}/${segment(repo)}`;
  return subject.kind === "item"
    ? `${base}/issues/${subject.issueNumber}/reactions`
    : `${base}/issues/comments/${subject.commentId}/reactions`;
}

/** Owner and repository names reach us from webhook bodies, so they are never trusted raw. */
function segment(value: string): string {
  return encodeURIComponent(value);
}
