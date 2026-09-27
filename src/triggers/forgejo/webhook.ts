import type { ProviderEventAcceptance } from "../../db/types.js";
import { isDatabaseUnavailableError } from "../../db/errors.js";
import { reportFailure } from "../../failures/index.js";
import { logger } from "../../logger.js";
import { logProviderEventIntake } from "../audit.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import type { ForgejoEnrichmentDeps } from "./enrichment.js";
import { enrichForgejoWebhookEvent, forgejoEventCanEnrich } from "./enrichment.js";
import { forgejoSourceName } from "./events.js";
import type { NormalizedForgejoEvent } from "./events.js";
import { isForgejoOwnAccountEvent } from "./loop-guard.js";
import { verifyForgejoRequest } from "./webhook-verify.js";
import type { ForgejoWebhookConnection, VerifiedForgejoWebhook } from "./webhook-verify.js";

export type { ForgejoWebhookConnection } from "./webhook-verify.js";

export interface ForgejoWebhookSourceOptions extends ForgejoEnrichmentDeps {
  /**
   * Resolve the connection named in the delivery URL.
   *
   * Returning undefined is answered exactly like a bad signature, so this never becomes
   * an oracle for which connection ids exist.
   */
  findConnection(connectionId: string): Promise<ForgejoWebhookConnection | undefined>;
  accept(input: {
    connectionId: string;
    /** Absent for a delivery that names no repository at all. */
    repositoryId?: number;
    deliveryId: string;
    signatureHash: string;
    source: string;
    repo?: string;
    payload: unknown;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
    enrichmentPending?: boolean;
  }): Promise<ProviderEventAcceptance>;
  /**
   * Clears the "enrichment pending" marker accept() set, writing the enriched payload
   * first if there is one, so a later replay carries the enrichment instead of being
   * answered as a duplicate. Best effort: a failure just leaves the marker to go stale.
   */
  completeEnrichment?(receiptId: string, payload?: unknown): Promise<void>;
  /** Overall budget for one delivery, from the request's arrival. Defaults to
   * FORGEJO_ENRICHMENT_DEADLINE_MS; tests shorten it. */
  enrichmentDeadlineMs?: number;
}

// Forgejo's whole-delivery budget (webhook.DELIVER_TIMEOUT, 5s by default). Forgejo
// never retries a delivery on its own, it just marks it failed after this and moves
// on. Every constant below is a slice of this one number.
const FORGEJO_DELIVER_TIMEOUT_MS = 5_000;

/** Enrichment's slice of FORGEJO_DELIVER_TIMEOUT_MS. Leaves margin for
 * completeEnrichment and the handlers that run after (one makes its own HTTP call
 * back to Forgejo). */
export const FORGEJO_ENRICHMENT_DEADLINE_MS = 2_500;

/** How long past the deadline to wait for enrichment that ignores its signal. */
const ENRICHMENT_BACKSTOP_MS = 250;

/** Extra slack for the owner's completeEnrichment write and clock skew, so a
 * duplicate doesn't log the owner as overdue too early. */
const ENRICHMENT_COMPLETION_SLACK_MS = 500;

/**
 * A duplicate arriving while a receipt's marker is held always answers 200, since
 * Forgejo never retries. Past this budget the owner probably got stuck, so it logs a
 * warning instead.
 */
export const FORGEJO_ENRICHMENT_DUPLICATE_BUDGET_MS =
  FORGEJO_ENRICHMENT_DEADLINE_MS + ENRICHMENT_BACKSTOP_MS + ENRICHMENT_COMPLETION_SLACK_MS;

// fails fast if a future edit leaves no margin inside Forgejo's own deliver timeout.
if (FORGEJO_ENRICHMENT_DEADLINE_MS + ENRICHMENT_BACKSTOP_MS >= FORGEJO_DELIVER_TIMEOUT_MS) {
  throw new Error("forgejo enrichment budget leaves no margin inside the deliver timeout");
}

export interface ForgejoWebhookEndpoint extends TriggerSource {
  handle(request: Request): Promise<Response>;
}

export function createForgejoWebhookSource(
  options: ForgejoWebhookSourceOptions,
): ForgejoWebhookEndpoint {
  const handlers = new Set<TriggerHandler>();

  async function handle(request: Request): Promise<Response> {
    const deadlineAt =
      Date.now() + (options.enrichmentDeadlineMs ?? FORGEJO_ENRICHMENT_DEADLINE_MS);
    try {
      const verified = await verifyForgejoRequest(request, options);
      if (verified instanceof Response) return verified;
      return await dispatchForgejoWebhook(verified, options, handlers, deadlineAt);
    } catch (error) {
      const status = isDatabaseUnavailableError(error) ? 503 : 500;
      reportFailure(
        error,
        {
          operation: "forgejo.webhook.handle",
          component: "triggers",
          provider: "forgejo",
          status,
        },
        { status },
      );
      if (isDatabaseUnavailableError(error)) {
        return Response.json({ error: "database_unavailable" }, { status: 503 });
      }
      return Response.json({ error: "webhook_processing_failed" }, { status: 500 });
    }
  }

  return {
    handle,
    async start(nextHandler: TriggerHandler): Promise<void> {
      handlers.add(nextHandler);
    },
    async stop(): Promise<void> {
      handlers.clear();
    },
  };
}

async function dispatchForgejoWebhook(
  verified: VerifiedForgejoWebhook,
  options: ForgejoWebhookSourceOptions,
  handlers: Set<TriggerHandler>,
  deadlineAt: number,
): Promise<Response> {
  const source = forgejoSourceName(verified.eventType);

  // authentic but names no repository, nothing to route on. Not rejected, but the
  // receipt is still stored with the same drop reason GitHub's equivalent path uses.
  if (verified.event === undefined) {
    logger.info(
      { deliveryId: verified.deliveryId, eventType: verified.eventType },
      "skipping Forgejo delivery without a repository",
    );
    const acceptance = await options.accept({
      connectionId: verified.connection.id,
      deliveryId: verified.deliveryId,
      signatureHash: verified.signatureHash,
      source,
      payload: verified.payload,
      receivedAt: new Date(),
      dropReason: "no_trigger_for_source",
    });
    logProviderEventIntake({
      provider: "forgejo",
      source,
      deliveryId: verified.deliveryId,
      acceptance,
    });
    return new Response("OK", { status: 200 });
  }

  const event = verified.event;
  // the agent writes back to Forgejo with this connection's own token, so those
  // writes come back here as deliveries from the connection's own (or a sibling's)
  // account. None of those may reach a handler, or the agent would react to itself.
  const ownAccount = isForgejoOwnAccountEvent(event, [
    verified.connection.accountId,
    ...(verified.connection.siblingAccountIds ?? []),
  ]);
  if (ownAccount) {
    logger.info(
      { deliveryId: verified.deliveryId, repo: event.repo, connectionId: verified.connection.id },
      "skipping Forgejo delivery, its sender is the connection's own account",
    );
  }
  let dropReason: ProviderEventDropReasonCode | undefined;
  if (ownAccount) dropReason = "own_account";
  else if (handlers.size === 0) dropReason = "configuration_unavailable";

  // two deliveries can share a signature (resubscribe overlap, a duplicate hook).
  // accept() dedupes on the signature and marks the receipt "enrichment pending" in
  // the same write when this delivery will enrich. A duplicate that finds the marker
  // held always answers 200 without dispatching. A marker left by a dead owner goes
  // stale after a few minutes and the next duplicate takes it over.
  const acceptance = await options.accept({
    connectionId: verified.connection.id,
    repositoryId: event.repositoryId,
    deliveryId: verified.deliveryId,
    signatureHash: verified.signatureHash,
    source,
    repo: event.repo,
    payload: event,
    receivedAt: new Date(event.createdAt),
    enrichmentPending: forgejoEventCanEnrich(event, options),
    ...(dropReason === undefined ? {} : { dropReason }),
  });

  logProviderEventIntake({
    provider: "forgejo",
    source,
    deliveryId: verified.deliveryId,
    repository: event.repo,
    resourceId: String(event.repositoryId),
    acceptance,
  });

  // still enriching under the marker, not old enough to take over. Always 200 since
  // Forgejo never retries; past the budget it's probably stuck, so warn instead.
  if (acceptance.status === "pending") {
    if (acceptance.ageMs > FORGEJO_ENRICHMENT_DUPLICATE_BUDGET_MS) {
      logger.warn(
        { deliveryId: verified.deliveryId, repo: event.repo, ageMs: acceptance.ageMs },
        "forgejo enrichment marker outlived its duplicate budget, still answering 200",
      );
    }
    return new Response("OK", { status: 200 });
  }
  if (acceptance.status !== "accepted") return new Response("OK", { status: 200 });

  const events =
    acceptance.ownsEnrichment === true
      ? await enrichAcceptedForgejoEvents(
          event,
          verified.connection,
          acceptance,
          options,
          deadlineAt,
        )
      : acceptance.events;
  await Promise.all(
    events.flatMap((accepted) => Array.from(handlers, (handler) => handler(accepted))),
  );
  return new Response("OK", { status: 200 });
}

/**
 * Enriches the delivery holding the marker, then clears it. Bounded by deadlineAt:
 * the signal cuts the Forgejo calls short, and a backstop covers anything that
 * ignores it. Past the deadline, dispatches the un-enriched event.
 */
async function enrichAcceptedForgejoEvents(
  event: NormalizedForgejoEvent,
  connection: ForgejoWebhookConnection,
  accepted: Extract<ProviderEventAcceptance, { status: "accepted" }>,
  options: ForgejoWebhookSourceOptions,
  deadlineAt: number,
) {
  const remaining = Math.max(0, deadlineAt - Date.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  let backstop: NodeJS.Timeout | undefined;
  // true only if the backstop promise actually won the race, not just whether the
  // abort signal fired (enrichment can respect its own deadline and return quickly).
  let backstopWon = false;
  // findConnection already loaded these credentials for this request, so reuse them
  // instead of a second identical row lookup.
  const enrichmentDeps: ForgejoEnrichmentDeps = {
    ...options,
    credentialsForConnection: () => Promise.resolve(connection.credentials),
  };
  // on a stale-marker takeover this is the ORIGINAL delivery's stored time, not this
  // later request's arrival.
  const recencyAnchor = accepted.events[0]?.receivedAt;
  let enriched: NormalizedForgejoEvent;
  try {
    enriched = await Promise.race([
      enrichForgejoWebhookEvent(
        event,
        enrichmentDeps,
        controller.signal,
        accepted.receiptId,
        recencyAnchor,
      ),
      new Promise<NormalizedForgejoEvent>((resolve) => {
        backstop = setTimeout(() => {
          backstopWon = true;
          resolve(event);
        }, remaining + ENRICHMENT_BACKSTOP_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    clearTimeout(backstop);
  }
  if (backstopWon) {
    logger.warn(
      { deliveryId: event.id, repo: event.repo },
      "forgejo enrichment ignored its deadline, the backstop dispatched without it",
    );
  }

  // a review's recovered text doesn't touch addedLabels/addedAssignees, so check for
  // a new payload reference too (enrichForgejoWebhookEvent returns the same
  // reference back when nothing changed).
  const hasEnrichment =
    (enriched.addedLabels?.length ?? 0) > 0 ||
    (enriched.addedAssignees?.length ?? 0) > 0 ||
    enriched.payload !== event.payload;

  try {
    await options.completeEnrichment?.(accepted.receiptId, hasEnrichment ? enriched : undefined);
  } catch (error) {
    logger.warn(
      { err: error, deliveryId: event.id, repo: event.repo },
      "forgejo enrichment completion failed, the receipt stays pending until it goes stale",
    );
  }
  if (!hasEnrichment) return accepted.events;
  return accepted.events.map((durableEvent) => ({ ...durableEvent, payload: enriched }));
}
