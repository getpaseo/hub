import { z } from "zod";
import {
  connectionActionFailure,
  manageConnectionAccess,
  requiredConnectionId,
} from "../../connections/shared.js";
import type { ForgejoConnectionRecord, ForgejoWebhookRecord } from "../../db/types.js";
import { logger } from "../../logger.js";
import {
  ForgejoApiError,
  type ForgejoApiClient,
  type ForgejoCredentials,
  type ForgejoHookSummary,
  type ForgejoHookTarget,
} from "./client.js";
import {
  credentialsFor,
  withForgejoHookLease,
  forgejoWebhookUrl,
  requireOwnForgejoConnection,
  type CreateForgejoConnectionOptions,
} from "./connection.js";
import { normalizeInstanceBaseUrl } from "./instance-url.js";
import { supportsForgejoActionRunHookEvents } from "./instance-flavor.js";

// issues and pull_request are blanket keys: forgejo's addHook ORs every sub-event's own
// check against the blanket key, so these two alone also cover labels, assignees,
// comments and reviews. push is separate and is what forgejo.push triggers subscribe to.
export const FORGEJO_HOOK_EVENTS = ["issues", "pull_request", "push"] as const;

// their own two keys, unlike issues/pull_request above, and only sent to instances
// supportsForgejoActionRunHookEvents accepts, so an old instance's hook ui never sees
// an event string it has never heard of
const FORGEJO_ACTION_RUN_HOOK_EVENTS = ["action_run_failure", "action_run_success"] as const;

// existing subscriptions predating this gate need a resubscribe to pick up the new events
function forgejoHookEventsFor(
  connection: Pick<ForgejoConnectionRecord, "instanceFlavor" | "instanceVersion">,
): readonly string[] {
  return supportsForgejoActionRunHookEvents(connection)
    ? [...FORGEJO_HOOK_EVENTS, ...FORGEJO_ACTION_RUN_HOOK_EVENTS]
    : FORGEJO_HOOK_EVENTS;
}

// stored owner for every user-scope hook row, regardless of the account's actual login.
// the unique index is on (connectionId, scope, owner), and a login rename would otherwise
// land on a fresh row instead of the same one, leaving the old row's hook untracked
export const FORGEJO_USER_SCOPE_OWNER = "self";

const SubscribeBodySchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("user") }),
  z.object({ scope: z.literal("org"), org: z.string().min(1) }),
]);

// a target never ends up with two tracked hooks at hub's url: every existing one there
// is superseded by a fresh create, not added alongside. serialized per connection by the
// hook lease, so a concurrent subscribe or disconnect can't race this
export function createForgejoSubscribeAction(
  options: CreateForgejoConnectionOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      const connectionId = requiredConnectionId(request);
      const body: unknown = await request.json().catch(() => undefined);
      const parsed = SubscribeBodySchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_subscribe_target" }, { status: 400 });
      }
      const connection = await requireOwnForgejoConnection(options.database, access, connectionId);
      return await withForgejoHookLease(
        options.database,
        access.tenant.organization.id,
        connectionId,
        () => subscribeLeased(options, connection, parsed.data),
      );
    } catch (error) {
      return connectionActionFailure(error, "forgejo", "subscribe");
    }
  };
}

async function subscribeLeased(
  options: CreateForgejoConnectionOptions,
  connection: ForgejoConnectionRecord,
  target: z.infer<typeof SubscribeBodySchema>,
): Promise<Response> {
  // lowercased so "Acme" and "acme" are the same stored target, forgejo itself looks
  // users and orgs up by lowercased name
  const owner = (target.scope === "user" ? connection.accountLogin : target.org).toLowerCase();
  const hookTarget = hookTargetFor({ scope: target.scope, owner });
  const credentials = credentialsFor(connection);
  const url = forgejoWebhookUrl(options.applicationBaseUrl, connection.id);

  let existing: ForgejoHookSummary[];
  try {
    existing = await options.api.listHooks(credentials, hookTarget);
  } catch (error) {
    const denied = hookPermissionResponse(error);
    if (denied !== undefined) return denied;
    throw error;
  }
  const stale = existing.filter((hook) => hook.url !== undefined && sameUrl(hook.url, url));

  const created = await createSubscribedHook(options.api, credentials, hookTarget, connection, url);
  if (created instanceof Response) return created;

  try {
    await options.database.recordForgejoWebhook({
      connectionId: connection.id,
      scope: target.scope,
      owner: target.scope === "user" ? FORGEJO_USER_SCOPE_OWNER : owner,
      hookId: created.hookId,
    });
  } catch (error) {
    // the remote hook now exists but hub never learned its id, roll it back instead of
    // leaving an orphan nothing points at
    await options.api.deleteHook(credentials, hookTarget, created.hookId).catch((cleanupError) => {
      logger.warn(
        { err: cleanupError, provider: "forgejo", hookId: created.hookId },
        "forgejo hook create succeeded but recording it failed, and the compensating delete also failed",
      );
    });
    throw error;
  }

  // best effort: a delete failure here leaves a stale hook alongside the tracked one,
  // the next subscribe finds and clears it
  await Promise.all(
    stale.map((hook) =>
      options.api.deleteHook(credentials, hookTarget, hook.id).catch((error) => {
        logger.warn(
          { err: error, provider: "forgejo", hookId: hook.id },
          "forgejo superseded hook delete failed after resubscribe, leaving it in place",
        );
      }),
    ),
  );

  return Response.json({ scope: target.scope, owner, webhookUrl: url });
}

function sameUrl(left: string, right: string): boolean {
  return normalizeInstanceBaseUrl(left) === normalizeInstanceBaseUrl(right);
}

// user scope ignores owner entirely, org scope needs it; shared so subscribe and
// disconnect never diverge on how a record maps to a call target
function hookTargetFor(record: { scope: "user" | "org"; owner: string }): ForgejoHookTarget {
  return record.scope === "user" ? { scope: "user" } : { scope: "org", org: record.owner };
}

// always creates fresh, even when a hook already sits at hub's url: forgejo's list
// response never returns a hook's secret, so a found-by-url hook could carry a
// different secret and fail every signature check silently. PATCH can't fix this either,
// forgejo's editHook never reads config.secret, only create does. create runs before
// delete so a create failure leaves the old hook in place for a retry; the overlap
// window where both hooks are live means a delivery can land twice, but both hooks
// share the same secret so the duplicate signature hash is dropped, not double processed.
async function createSubscribedHook(
  api: ForgejoApiClient,
  credentials: ForgejoCredentials,
  target: ForgejoHookTarget,
  connection: Pick<ForgejoConnectionRecord, "webhookSecret" | "instanceFlavor" | "instanceVersion">,
  url: string,
): Promise<{ hookId: number } | Response> {
  try {
    const created = await api.createHook(credentials, target, {
      url,
      secret: connection.webhookSecret,
      events: forgejoHookEventsFor(connection),
    });
    return { hookId: created.id };
  } catch (error) {
    const denied = hookPermissionResponse(error);
    if (denied !== undefined) return denied;
    throw error;
  }
}

// told apart by the instance's own status: 403 means the token can't manage hooks here,
// 404 on an org target means the org itself was never found (a typo'd name, not a scope
// problem), 422 means the instance rejected the hook itself and carries its own reason
// in detail. distinct from connectionActionFailure's 403, which is hub refusing the caller.
function hookPermissionResponse(error: unknown): Response | undefined {
  if (!(error instanceof ForgejoApiError)) return undefined;
  if (error.status === 403) {
    return Response.json({ error: "hook_permission_denied" }, { status: 422 });
  }
  if (error.status === 404) {
    return Response.json({ error: "hook_target_not_found" }, { status: 404 });
  }
  if (error.status === 422) {
    return Response.json(
      { error: "hook_rejected", ...(error.detail === undefined ? {} : { reason: error.detail }) },
      { status: 422 },
    );
  }
  return undefined;
}

// deletes every hook this connection tracked, grouped by remote target so a shared
// target lists its hooks once and sweeps orphans in one pass, instead of racing another
// row's sweep to delete the same orphan twice. failures are logged and swallowed, this
// must never block whatever removed the connection.
export async function deleteConnectionHooksBestEffort(
  api: ForgejoApiClient,
  credentials: ForgejoCredentials,
  webhookUrl: string,
  hooks: readonly ForgejoWebhookRecord[],
): Promise<void> {
  await Promise.all(
    groupHooksByTarget(hooks).map(({ target, hookIds }) =>
      deleteHookGroup(api, credentials, webhookUrl, target, hookIds),
    ),
  );
}

// every tracked hookId that resolves to the same remote target
function groupHooksByTarget(
  hooks: readonly ForgejoWebhookRecord[],
): { target: ForgejoHookTarget; hookIds: readonly number[] }[] {
  const groups = new Map<string, { target: ForgejoHookTarget; hookIds: number[] }>();
  for (const hook of hooks) {
    const target = hookTargetFor(hook);
    const key = target.scope === "user" ? "user" : `org:${target.org}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { target, hookIds: [hook.hookId] });
    } else {
      group.hookIds.push(hook.hookId);
    }
  }
  return Array.from(groups.values());
}

async function deleteHookGroup(
  api: ForgejoApiClient,
  credentials: ForgejoCredentials,
  webhookUrl: string,
  target: ForgejoHookTarget,
  hookIds: readonly number[],
): Promise<void> {
  await Promise.all(
    hookIds.map((hookId) =>
      api.deleteHook(credentials, target, hookId).catch((error: unknown) => {
        logger.warn(
          { err: error, provider: "forgejo", hookId },
          "forgejo hook delete failed on disconnect, continuing",
        );
      }),
    ),
  );

  let found: ForgejoHookSummary[];
  try {
    found = await api.listHooks(credentials, target);
  } catch (error) {
    logger.warn(
      { err: error, provider: "forgejo", ...target },
      "forgejo orphaned hook listing failed on disconnect, continuing",
    );
    return;
  }
  // excludes ids already handled above, keeping one delete attempt per remote hook
  const tracked = new Set(hookIds);
  const orphaned = found.filter(
    (candidate) =>
      !tracked.has(candidate.id) &&
      candidate.url !== undefined &&
      sameUrl(candidate.url, webhookUrl),
  );
  await Promise.all(
    orphaned.map((candidate) =>
      api.deleteHook(credentials, target, candidate.id).catch((error: unknown) => {
        logger.warn(
          { err: error, provider: "forgejo", hookId: candidate.id },
          "forgejo orphaned hook delete failed on disconnect, continuing",
        );
      }),
    ),
  );
}

const HOOK_CLEANUP_STALL_MS = 30_000;

// runs deleteConnectionHooksBestEffort without making the caller wait: the connection
// row is already gone, so a slow instance must never hold up the response. not
// cancellable, so a run past HOOK_CLEANUP_STALL_MS is only logged, not aborted.
export function deleteConnectionHooksDetached(
  api: ForgejoApiClient,
  credentials: ForgejoCredentials,
  webhookUrl: string,
  hooks: readonly ForgejoWebhookRecord[],
  context: { connectionId: string },
): void {
  let settled = false;
  const stall = setTimeout(() => {
    if (!settled) {
      logger.warn(
        { provider: "forgejo", ...context },
        "forgejo hook cleanup on disconnect is still running past its deadline",
      );
    }
  }, HOOK_CLEANUP_STALL_MS);
  stall.unref();
  void deleteConnectionHooksBestEffort(api, credentials, webhookUrl, hooks)
    .catch((error: unknown) => {
      logger.warn(
        { err: error, provider: "forgejo", ...context },
        "forgejo hook cleanup on disconnect failed unexpectedly",
      );
    })
    .finally(() => {
      settled = true;
      clearTimeout(stall);
    });
}
