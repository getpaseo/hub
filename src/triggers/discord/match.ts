import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type { NormalizedDiscordMessageEvent } from "./events.js";
import type { TriggerRoutingDecision } from "../routing-evidence.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedDiscordTrigger {
  event: NormalizedDiscordMessageEvent;
  trigger: MatchedTriggerDefinition;
}

export interface DiscordTriggerEvaluation {
  matches: MatchedDiscordTrigger[];
  routingDecisions: TriggerRoutingDecision[];
}

export function matchDiscordTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
  connectionId?: string | null,
): MatchedDiscordTrigger[] {
  return evaluateDiscordTriggers(config, event, botClientId, connectionId).matches;
}

export function evaluateDiscordTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
  connectionId?: string | null,
): DiscordTriggerEvaluation {
  const expectedEventName = `discord.${event.type}`;
  const matches: MatchedDiscordTrigger[] = [];
  const routingDecisions: TriggerRoutingDecision[] = [];

  for (const trigger of config.triggers) {
    if (trigger.on !== expectedEventName) {
      routingDecisions.push({ triggerName: trigger.name, code: "no_trigger_for_source" });
      continue;
    }
    const mismatch = discordFilterMismatch(event, trigger.filters, botClientId, connectionId);
    if (mismatch !== undefined) {
      routingDecisions.push({ triggerName: trigger.name, code: mismatch });
      continue;
    }
    matches.push({ event, trigger });
  }

  return { matches, routingDecisions };
}

function discordFilterMismatch(
  event: NormalizedDiscordMessageEvent,
  filter: TriggerFilter | undefined,
  botClientId: string,
  connectionId?: string | null,
):
  | "connection_mismatch"
  | "guild_mismatch"
  | "channel_mismatch"
  | "sender_not_allowed"
  | "contains_mismatch"
  | "pattern_mismatch"
  | undefined {
  const pattern = filter === undefined ? undefined : readPatternFilter(filter);
  if (filter === undefined || !hasBotMention(event, botClientId)) {
    return "contains_mismatch";
  }
  if (pattern !== undefined && !matchesBotMentionPattern(event, botClientId, pattern)) {
    return readStringFilter(filter, "pattern") === undefined
      ? "contains_mismatch"
      : "pattern_mismatch";
  }

  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) {
    return "connection_mismatch";
  }

  if (filter.from_users === undefined || filter.from_users.length === 0) {
    return "sender_not_allowed";
  }

  const guild = readStringFilter(filter, "guild");
  if (guild !== undefined && guild !== event.guildId) {
    return "guild_mismatch";
  }

  const channels = readStringArrayFilter(filter, "channels");
  if (channels !== undefined && !matchesChannel(event, channels)) {
    return "channel_mismatch";
  }

  if (!filter.from_users.includes(event.author.id)) {
    return "sender_not_allowed";
  }

  return undefined;
}

export function readDiscordPromptBody(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
): string {
  const mention = findBotMention(event, botClientId);
  return mention === undefined
    ? event.content
    : event.content.slice(mention.index + mention.token.length).trimStart();
}

export function readDiscordMentionToken(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
): string | undefined {
  return findBotMention(event, botClientId)?.token;
}

export function readDiscordInvocationParserMessage(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
  filter: TriggerFilter | undefined,
): string {
  const body = readDiscordPromptBody(event, botClientId);
  const marker = filter === undefined ? undefined : readPatternFilter(filter);
  if (
    marker === undefined ||
    marker.length === 0 ||
    marker.includes("=") ||
    !body.startsWith(marker)
  )
    return body;
  const nextCharacter = body.at(marker.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter)
    ? body.slice(marker.length).trimStart()
    : body;
}

function matchesBotMentionPattern(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
  pattern: string | undefined,
): boolean {
  if (
    !event.mentionedUserIds.includes(botClientId) &&
    (event.mentionedBotRoleIds ?? []).length === 0
  ) {
    return false;
  }

  const afterMention = readDiscordPromptBody(event, botClientId);
  if (pattern === undefined || pattern.length === 0) {
    return true;
  }

  if (!afterMention.startsWith(pattern)) {
    return false;
  }

  const nextCharacter = afterMention.at(pattern.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter);
}

function hasBotMention(event: NormalizedDiscordMessageEvent, botClientId: string): boolean {
  return (
    event.mentionedUserIds.includes(botClientId) || (event.mentionedBotRoleIds?.length ?? 0) > 0
  );
}

function findBotMention(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
): { index: number; token: string } | undefined {
  const tokens = [
    ...(event.mentionedUserIds.includes(botClientId)
      ? [`<@${botClientId}>`, `<@!${botClientId}>`]
      : []),
    ...(event.mentionedBotRoleIds ?? []).map((roleId) => `<@&${roleId}>`),
  ];

  return tokens
    .map((token) => ({ index: event.content.indexOf(token), token }))
    .find((mention) => mention.index >= 0);
}

function readPatternFilter(filter: TriggerFilter): string | undefined {
  return readStringFilter(filter, "pattern") ?? readStringFilter(filter, "contains");
}

function matchesChannel(event: NormalizedDiscordMessageEvent, channels: string[]): boolean {
  if (channels.includes(event.channelId)) {
    return true;
  }

  return event.parentChannelId !== null && channels.includes(event.parentChannelId);
}

function readStringFilter(
  filter: TriggerFilter,
  key: "guild" | "pattern" | "contains",
): string | undefined {
  const value = filter[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArrayFilter(filter: TriggerFilter, key: "channels"): string[] | undefined {
  const value = filter[key];

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}
