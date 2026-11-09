import type { ProviderEventSummary } from "../presentation.js";
import { NormalizedDiscordMessageEventSchema } from "../../triggers/discord/events.js";
import { truncateEventText as truncate } from "../presentation.js";

export function summarizeEvent(payload: unknown): ProviderEventSummary {
  const event = NormalizedDiscordMessageEventSchema.safeParse(payload);
  if (!event.success) {
    return { provider: "discord", headline: "Discord mention", actor: null, externalUrl: null };
  }
  const content = event.data.content.trim();
  return {
    provider: "discord",
    headline: content.length > 0 ? truncate(content, 96) : "Discord mention",
    actor: event.data.author.username,
    externalUrl: `https://discord.com/channels/${event.data.guildId}/${event.data.channelId}/${event.data.messageId}`,
  };
}
