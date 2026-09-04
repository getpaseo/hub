import type { FailureContext } from "../failures/index.js";
import { reportFailure } from "../failures/index.js";
import type { DurableProviderEvent } from "../db/types.js";
import type { TriggerHandler } from "./index.js";

/**
 * The largest webhook body any provider will read. Deliveries above this are refused with 413
 * before the body is buffered, so a hostile or runaway sender cannot exhaust memory.
 */
export const MAX_WEBHOOK_BYTES = 1_048_576;

/**
 * Successful parse result. `unknown | Response` collapses to `unknown`, so the value is wrapped
 * to keep the `instanceof Response` discrimination the call sites rely on.
 */
export interface ParsedWebhookBody {
  payload: unknown;
}

/**
 * Decodes strict UTF-8 and parses JSON, returning a 400 `Response` on either failure. Strict
 * decoding matters: a lenient decoder would silently replace invalid bytes and hand downstream
 * validation a payload that differs from what the provider actually sent.
 */
export function parseWebhookJsonBody(input: {
  body: Uint8Array;
  operation: string;
  provider: FailureContext["provider"];
  scrubValues: readonly string[];
}): ParsedWebhookBody | Response {
  try {
    return { payload: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body)) };
  } catch (error) {
    reportFailure(
      error,
      {
        operation: input.operation,
        component: "triggers",
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        status: 400,
      },
      { status: 400, scrubValues: [...input.scrubValues] },
    );
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
}

export interface WebhookHandlerRegistry {
  handlers: Set<TriggerHandler>;
  start: (handler: TriggerHandler) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * The `TriggerSource` start/stop pair every webhook provider implements identically. The set is
 * exposed because handlers must also be counted (an empty registry means the runtime has no
 * configuration loaded yet, which providers report as a `configuration_unavailable` drop).
 */
export function createWebhookHandlerRegistry(): WebhookHandlerRegistry {
  const handlers = new Set<TriggerHandler>();
  return {
    handlers,
    start: async (handler: TriggerHandler): Promise<void> => {
      handlers.add(handler);
    },
    stop: async (): Promise<void> => {
      handlers.clear();
    },
  };
}

/** Fans one accepted delivery out to every registered handler and answers the provider with 200. */
export async function dispatchWebhookEvents(
  handlers: ReadonlySet<TriggerHandler>,
  events: readonly DurableProviderEvent[],
): Promise<Response> {
  await Promise.all(events.flatMap((event) => Array.from(handlers, (handler) => handler(event))));
  return new Response("OK", { status: 200 });
}
