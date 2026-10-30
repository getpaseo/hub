import type { ProviderEventAcceptance } from "../../../../db/types.js";
import { logProviderEventIntake } from "../../../audit.js";
import type { ProviderEventDropReasonCode } from "../../../drop-reason.js";
import type { TriggerHandler } from "../../../index.js";
import { normalizeSlackEvent, SlackEventCallbackSchema } from "../../events.js";

export interface SlackEventIntakeOptions {
  appId: string;
  accept(input: {
    teamId: string;
    deliveryId: string;
    signatureHash: string;
    source: string;
    payload: unknown;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
}

export class SlackEventIntakeValidationError extends Error {
  override name = "SlackEventIntakeValidationError";
}

export type AcceptedSlackEvents = Extract<
  ProviderEventAcceptance,
  { status: "accepted" }
>["events"];

/** Transport-blind durable handoff for Slack Events API callbacks. */
export async function intakeSlackEvent(
  payload: unknown,
  signatureHash: string,
  handlers: ReadonlySet<TriggerHandler>,
  options: SlackEventIntakeOptions,
): Promise<void> {
  const events = await acceptSlackEvent(payload, signatureHash, handlers, options);
  await dispatchSlackEvents(events, handlers);
}

/** Records the callback durably and returns the events to hand to the triggers. */
export async function acceptSlackEvent(
  payload: unknown,
  signatureHash: string,
  handlers: ReadonlySet<TriggerHandler>,
  options: SlackEventIntakeOptions,
): Promise<AcceptedSlackEvents> {
  const callback = SlackEventCallbackSchema.safeParse(payload);
  if (!callback.success) throw new SlackEventIntakeValidationError();
  if (callback.data.api_app_id !== options.appId) {
    throw new SlackEventIntakeValidationError();
  }
  const normalizedEvent = normalizeSlackEvent(callback.data);
  if (normalizedEvent === undefined) return [];

  const deliveryId = `slack-${normalizedEvent.id}`;
  const acceptance = await options.accept({
    teamId: normalizedEvent.teamId,
    deliveryId,
    signatureHash,
    source: "slack.mention",
    payload: normalizedEvent,
    receivedAt: new Date(normalizedEvent.eventTime * 1_000),
    ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" } : {}),
  });
  logProviderEventIntake({
    provider: "slack",
    source: "slack.mention",
    deliveryId,
    resourceId: normalizedEvent.teamId,
    acceptance,
  });
  return acceptance.status === "accepted" ? acceptance.events : [];
}

/** Hands accepted events to every trigger handler. */
export async function dispatchSlackEvents(
  events: AcceptedSlackEvents,
  handlers: ReadonlySet<TriggerHandler>,
): Promise<void> {
  await Promise.all(
    events.flatMap((acceptedEvent) => Array.from(handlers, (handler) => handler(acceptedEvent))),
  );
}
