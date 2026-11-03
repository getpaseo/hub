import type { ProviderEventAcceptance } from "../../db/types.js";
import { logProviderEventIntake } from "../audit.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import type { TriggerHandler } from "../index.js";
import { parseGoogleChatMentionEvent } from "./events.js";

export interface GoogleChatEventIntakeOptions {
  projectId: string;
  accept(input: {
    projectId: string;
    deliveryId: string;
    signatureHash?: string | null;
    source: string;
    payload: unknown;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
}

export class GoogleChatEventIntakeValidationError extends Error {
  override name = "GoogleChatEventIntakeValidationError";
  readonly code = "invalidInput";
}

export async function intakeGoogleChatEvent(
  payload: unknown,
  signatureHash: string | null,
  handlers: ReadonlySet<TriggerHandler>,
  options: GoogleChatEventIntakeOptions,
): Promise<"accepted" | "ignored"> {
  const parsed = parseGoogleChatMentionEvent(payload, options.projectId);
  if (parsed.kind === "invalid") {
    throw new GoogleChatEventIntakeValidationError("Invalid Google Chat event payload.");
  }
  if (parsed.kind === "ignored") {
    return "ignored";
  }

  const event = parsed.event;
  const deliveryId = `google-chat-${event.messageName}`;
  const acceptance = await options.accept({
    projectId: options.projectId,
    deliveryId,
    signatureHash,
    source: "google-chat.mention",
    payload: event,
    receivedAt: new Date(event.createdAt),
    ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" } : {}),
  });

  logProviderEventIntake({
    provider: "google-chat",
    source: "google-chat.mention",
    deliveryId,
    resourceId: options.projectId,
    acceptance,
  });

  const events = acceptance.status === "accepted" ? acceptance.events : [];
  await Promise.all(
    events.flatMap((acceptedEvent) => Array.from(handlers, (handler) => handler(acceptedEvent))),
  );
  return "accepted";
}
