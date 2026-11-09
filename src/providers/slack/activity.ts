import type { ProviderEventSummary } from "../presentation.js";
import { NormalizedSlackMentionEventSchema } from "../../triggers/slack/events.js";
import { truncateEventText as truncate } from "../presentation.js";

export function summarizeEvent(payload: unknown): ProviderEventSummary {
  const event = NormalizedSlackMentionEventSchema.safeParse(payload);
  if (!event.success) {
    return { provider: "slack", headline: "Slack mention", actor: null, externalUrl: null };
  }
  const content = event.data.content.trim();
  return {
    provider: "slack",
    headline: content.length > 0 ? truncate(content, 96) : "Slack mention",
    actor: null,
    externalUrl: null,
  };
}
