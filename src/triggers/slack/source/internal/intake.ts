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

export type SlackEventIntakeResult =
  | { status: "ignored" }
  | { status: "accepted"; eventId: string; teamId: string };

export class SlackEventIntakeValidationError extends Error {
  constructor(readonly reason: "invalid_callback" | "wrong_app") {
    super(reason);
    this.name = "SlackEventIntakeValidationError";
  }
}

/** Transport-blind durable handoff for Slack Events API callbacks. */
export async function intakeSlackEvent(
  payload: unknown,
  signatureHash: string,
  handlers: ReadonlySet<TriggerHandler>,
  options: SlackEventIntakeOptions,
): Promise<SlackEventIntakeResult> {
  const callback = SlackEventCallbackSchema.safeParse(payload);
  if (!callback.success) throw new SlackEventIntakeValidationError("invalid_callback");
  if (callback.data.api_app_id !== options.appId) {
    throw new SlackEventIntakeValidationError("wrong_app");
  }
  const normalizedEvent = normalizeSlackEvent(callback.data);
  if (normalizedEvent === undefined) return { status: "ignored" };

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
  const events = acceptance.status === "accepted" ? acceptance.events : [];
  await Promise.all(
    events.flatMap((acceptedEvent) => Array.from(handlers, (handler) => handler(acceptedEvent))),
  );
  return { status: "accepted", eventId: normalizedEvent.id, teamId: normalizedEvent.teamId };
}
