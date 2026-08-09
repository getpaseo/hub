import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type { NormalizedSlackMentionEvent } from "./events.js";
import type { TriggerRoutingDecision } from "../routing-evidence.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedSlackTrigger {
  event: NormalizedSlackMentionEvent;
  trigger: MatchedTriggerDefinition;
}

export interface SlackTriggerEvaluation {
  matches: MatchedSlackTrigger[];
  routingDecisions: TriggerRoutingDecision[];
}

export function evaluateSlackTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedSlackMentionEvent,
  botUserId: string,
  connectionId?: string | null,
): SlackTriggerEvaluation {
  const matches: MatchedSlackTrigger[] = [];
  const routingDecisions: TriggerRoutingDecision[] = [];
  const sourceTriggers = config.triggers.filter((trigger) => trigger.on === "slack.mention");
  if (sourceTriggers.length === 0) {
    return {
      matches,
      routingDecisions: [{ triggerName: null, code: "no_trigger_for_source" }],
    };
  }

  for (const trigger of sourceTriggers) {
    const mismatch = slackFilterMismatch(event, trigger.filters, botUserId, connectionId);
    if (mismatch !== undefined) {
      routingDecisions.push({ triggerName: trigger.name, code: mismatch });
      continue;
    }
    matches.push({ event, trigger });
  }

  return { matches, routingDecisions };
}

export function matchSlackTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedSlackMentionEvent,
  botUserId: string,
  connectionId?: string | null,
): MatchedSlackTrigger[] {
  return evaluateSlackTriggers(config, event, botUserId, connectionId).matches;
}

function slackFilterMismatch(
  event: NormalizedSlackMentionEvent,
  filters: TriggerFilter | undefined,
  botUserId: string,
  connectionId?: string | null,
):
  | "connection_mismatch"
  | "workspace_mismatch"
  | "channel_mismatch"
  | "sender_not_allowed"
  | "contains_mismatch"
  | "pattern_mismatch"
  | undefined {
  if (event.author.id === botUserId) return "sender_not_allowed";
  if (filters === undefined || !event.content.includes(`<@${botUserId}>`)) {
    return "contains_mismatch";
  }
  if (filters.from_users === undefined || !filters.from_users.includes(event.author.id)) {
    return "sender_not_allowed";
  }
  if (filters.connectionId !== undefined && filters.connectionId !== connectionId) {
    return "connection_mismatch";
  }
  const workspace = readString(filters, "workspace");
  if (workspace !== undefined && workspace !== event.teamId) return "workspace_mismatch";
  const channels = readStrings(filters, "channels");
  if (channels !== undefined && !channels.includes(event.channelId)) return "channel_mismatch";
  const pattern = readString(filters, "pattern");
  const contains = readString(filters, "contains");
  const marker = pattern ?? contains;
  if (marker === undefined || marker.length === 0) return undefined;
  const body = readSlackPromptBody(event, botUserId);
  if (!body.startsWith(marker)) {
    return pattern === undefined ? "contains_mismatch" : "pattern_mismatch";
  }
  const nextCharacter = body.at(marker.length);
  if (nextCharacter === undefined || /\s/u.test(nextCharacter)) return undefined;
  return pattern === undefined ? "contains_mismatch" : "pattern_mismatch";
}

export function readSlackPromptBody(event: NormalizedSlackMentionEvent, botUserId: string): string {
  const mention = `<@${botUserId}>`;
  const index = event.content.indexOf(mention);
  return index < 0 ? event.content : event.content.slice(index + mention.length).trimStart();
}

export function readSlackInvocationParserMessage(
  event: NormalizedSlackMentionEvent,
  botUserId: string,
  filters: TriggerFilter | undefined,
): string {
  const body = readSlackPromptBody(event, botUserId);
  const marker = filters === undefined ? undefined : readPatternMarker(filters);
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

function readPatternMarker(filters: TriggerFilter): string | undefined {
  return readString(filters, "pattern") ?? readString(filters, "contains");
}

function readString(
  filters: TriggerFilter,
  key: "workspace" | "pattern" | "contains",
): string | undefined {
  const value = filters[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStrings(filters: TriggerFilter, key: "channels"): string[] | undefined {
  const value = filters[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;
}
