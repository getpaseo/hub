import type { ProviderEventSummary } from "../presentation.js";
import { NormalizedLinearEventSchema } from "../../triggers/linear/events.js";
import { truncateEventText as truncate } from "../presentation.js";

export function summarizeEvent(payload: unknown): ProviderEventSummary {
  const event = NormalizedLinearEventSchema.safeParse(payload);
  if (!event.success) {
    return { provider: "linear", headline: "Linear event", actor: null, externalUrl: null };
  }
  const issue = event.data.type === "issue" ? event.data.issue : event.data.issue;
  if (issue === null) {
    return {
      provider: "linear",
      headline: "Linear comment",
      actor: event.data.actor?.name ?? null,
      externalUrl: null,
    };
  }
  const prefix = issue.identifier === undefined ? "Issue" : issue.identifier;
  return {
    provider: "linear",
    headline: `${prefix}: ${truncate(issue.title, 96)}`,
    actor: event.data.actor?.name ?? event.data.actor?.id ?? null,
    externalUrl: issue.url ?? null,
  };
}
