import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import { normalizeSpaceName, type NormalizedGoogleChatMentionEvent } from "./events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedGoogleChatTrigger {
  event: NormalizedGoogleChatMentionEvent;
  trigger: MatchedTriggerDefinition;
}

export function matchGoogleChatTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedGoogleChatMentionEvent,
  connectionId?: string | null,
): MatchedGoogleChatTrigger[] {
  const expectedEventName = `google-chat.${event.type}`;
  const matches: MatchedGoogleChatTrigger[] = [];

  for (const trigger of config.triggers) {
    if (trigger.on !== expectedEventName || !matchesFilter(event, trigger.filters, connectionId)) {
      continue;
    }
    matches.push({ event, trigger });
  }

  return matches;
}

function matchesFilter(
  event: NormalizedGoogleChatMentionEvent,
  filter: TriggerFilter | undefined,
  connectionId?: string | null,
): boolean {
  if (filter === undefined) {
    return false;
  }

  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) {
    return false;
  }

  if (filter.from_users === undefined || filter.from_users.length === 0) {
    return false;
  }

  const pattern = readPatternFilter(filter);
  if (!matchesArgumentPattern(event.argumentText, pattern)) {
    return false;
  }

  const channels = readStringArrayFilter(filter, "channels");
  if (channels !== undefined && channels.length > 0 && !matchesSpace(event.spaceName, channels)) {
    return false;
  }

  return matchesFromUsers(event.author, filter.from_users);
}

export function readGoogleChatPromptBody(event: NormalizedGoogleChatMentionEvent): string {
  return event.argumentText;
}

export function readGoogleChatInvocationParserMessage(
  event: NormalizedGoogleChatMentionEvent,
  filter: TriggerFilter | undefined,
): string {
  const body = readGoogleChatPromptBody(event);
  const marker = filter === undefined ? undefined : readPatternFilter(filter);
  if (
    marker === undefined ||
    marker.length === 0 ||
    marker.includes("=") ||
    !body.startsWith(marker)
  ) {
    return body;
  }
  const nextCharacter = body.at(marker.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter)
    ? body.slice(marker.length).trimStart()
    : body;
}

function matchesArgumentPattern(argumentText: string, pattern: string | undefined): boolean {
  if (pattern === undefined || pattern.length === 0) {
    return true;
  }
  if (!argumentText.startsWith(pattern)) {
    return false;
  }
  const nextCharacter = argumentText.at(pattern.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter);
}

function matchesSpace(spaceName: string, allowedSpaces: readonly string[]): boolean {
  const normalizedTarget = normalizeSpaceName(spaceName);
  return allowedSpaces.some((candidate) => normalizeSpaceName(candidate) === normalizedTarget);
}

function matchesFromUsers(
  author: NormalizedGoogleChatMentionEvent["author"],
  allowedUsers: readonly string[],
): boolean {
  if (allowedUsers.includes("*")) {
    return true;
  }
  const normalizedAuthorId = normalizeUserResource(author.id);
  const authorEmailLower = author.email?.toLowerCase();

  return allowedUsers.some((entry) => {
    const trimmed = entry.trim();
    if (trimmed.length === 0) return false;
    if (trimmed === author.id || normalizeUserResource(trimmed) === normalizedAuthorId) {
      return true;
    }
    if (authorEmailLower !== undefined && trimmed.toLowerCase() === authorEmailLower) {
      return true;
    }
    return trimmed === author.displayName;
  });
}

function normalizeUserResource(value: string): string {
  return value.startsWith("users/") ? value : `users/${value}`;
}

function readPatternFilter(filter: TriggerFilter): string | undefined {
  return readStringFilter(filter, "pattern") ?? readStringFilter(filter, "contains");
}

function readStringFilter(filter: TriggerFilter, key: "pattern" | "contains"): string | undefined {
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
