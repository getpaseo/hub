import type {
  IntegrationQualifierDefinition,
  IntegrationQualifierKey,
  IntegrationTriggerAudience,
} from "../../integrations/browser-contracts.js";
import {
  defaultBrowserIntegrationRegistry,
  type BrowserIntegrationRegistry,
} from "../../integrations/browser-registry.js";

/** The YAML filter keys the form knows how to qualify. */
export type QualifierKey = IntegrationQualifierKey;

/** Draft values for the qualifiers declared by the selected event. */
export interface QualifierValues {
  label?: string | undefined;
  [key: string]: string | undefined;
}

export type QualifierDefinition = IntegrationQualifierDefinition;

/**
 * Who may invoke a trigger, as the form offers it. `members` and `contributors` are GitHub
 * repository associations; `everyone` and `specific` are the allowlist every provider has.
 */
export type TriggerAudience = IntegrationTriggerAudience;

export interface EventDefinition {
  provider: string;
  label: string;
  origin: "hub" | "provider";
  qualifiers: readonly QualifierDefinition[];
  /** The audiences the form offers for this event, default first. Empty when Hub is the source. */
  audiences: readonly TriggerAudience[];
  replyType?: string;
  audienceHint?: string;
}

const ALLOWLIST: readonly TriggerAudience[] = ["everyone", "specific"];

/** GitHub reports the actor's repository association on these events, so they start at members. */
const ASSOCIATION: readonly TriggerAudience[] = ["members", "contributors", ...ALLOWLIST];

const ADDED_LABEL: QualifierDefinition = {
  key: "label",
  kind: "string",
  label: "Added label",
  description:
    "Match the label added by this event, not labels already on the issue or pull request",
  required: true,
};

function event(
  provider: EventDefinition["provider"],
  label: string,
  { qualifiers = [], audiences }: Partial<Pick<EventDefinition, "qualifiers" | "audiences">> = {},
): EventDefinition {
  const origin =
    provider === "manual" || provider === "schedule" || provider === "webhook" ? "hub" : "provider";
  return {
    provider,
    label,
    qualifiers,
    origin,
    audiences: audiences ?? (origin === "hub" ? [] : ALLOWLIST),
  };
}

/** A GitHub event where GitHub guarantees the sender authored the created object it carries. */
function authored(label: string): EventDefinition {
  return event("github", label, { audiences: ASSOCIATION });
}

// The order is the event picker's. The events Hub sends itself come first because they work
// before any integration is connected.
const EVENTS = {
  "webhook.received": event("webhook", "Webhook received"),
  "schedule.tick": event("schedule", "Schedule"),
  "manual.run": event("manual", "Manual run"),
  "slack.mention": event("slack", "Slack mention"),
  "discord.mention": event("discord", "Discord mention"),
  "github.issue_created": authored("GitHub issue created"),
  "github.pull_request_created": authored("GitHub pull request created"),
  // A maintainer can mark another author's draft pull request ready or push to their fork branch;
  // in both cases GitHub reports only the pull request author's association, not the sender's.
  "github.pull_request_ready_for_review": event("github", "GitHub pull request ready for review"),
  "github.pull_request_synchronized": event(
    "github",
    "GitHub pull request updated with new commits",
  ),
  "github.issue_comment_created": authored("GitHub issue comment created"),
  "github.pull_request_comment_created": authored("GitHub pull request comment created"),
  // GitHub lets only people with triage access label, and the labeler is rarely the author
  // whose association the event reports, so these keep the plain allowlist.
  "github.issue_label_added": event("github", "GitHub issue label added", {
    qualifiers: [ADDED_LABEL],
  }),
  "github.pull_request_label_added": event("github", "GitHub pull request label added", {
    qualifiers: [ADDED_LABEL],
  }),
  // Raw multi-action webhooks also fire when a maintainer acts on another person's issue, pull
  // request, comment, or review, where GitHub omits the sender's association.
  "github.issue_comment": event("github", "GitHub issue or PR comment webhook"),
  "github.issues": event("github", "GitHub issue webhook"),
  "github.pull_request": event("github", "GitHub pull request webhook"),
  "github.pull_request_review": event("github", "GitHub pull request review webhook"),
  "github.pull_request_review_comment": event("github", "GitHub review comment webhook"),
  // GitHub restricts pushing to writers and reports no association on a push.
  "github.push": event("github", "GitHub push"),
  "linear.issue_entered_scope": event("linear", "Linear issue entered scope"),
  "linear.issue_assigned": event("linear", "Linear issue assigned"),
  "linear.comment_created": event("linear", "Linear comment created"),
};

const BUILT_IN_EVENTS = new Map<string, EventDefinition>(Object.entries(EVENTS));

export type EditorEvent = string;

export function editorEvents(
  registry: BrowserIntegrationRegistry = defaultBrowserIntegrationRegistry,
): readonly EditorEvent[] {
  return [
    ...BUILT_IN_EVENTS.keys(),
    ...registry
      .withTriggers()
      .flatMap((integration) => integration.triggers!.events.map((spec) => spec.id)),
  ];
}

export const EDITOR_EVENTS: readonly EditorEvent[] = editorEvents();

export function isEditorEvent(
  value: string,
  registry: BrowserIntegrationRegistry = defaultBrowserIntegrationRegistry,
): boolean {
  return BUILT_IN_EVENTS.has(value) || registry.forEvent(value) !== undefined;
}

export function parseEditorEvent(
  value: string,
  registry: BrowserIntegrationRegistry = defaultBrowserIntegrationRegistry,
): EditorEvent {
  return isEditorEvent(value, registry) ? value : "manual.run";
}

export function eventDefinition(
  eventId: EditorEvent,
  registry: BrowserIntegrationRegistry = defaultBrowserIntegrationRegistry,
): EventDefinition {
  const builtIn = BUILT_IN_EVENTS.get(eventId);
  if (builtIn !== undefined) return builtIn;
  const registered = registry.forEvent(eventId);
  if (registered !== undefined) {
    return {
      provider: registered.integration.id,
      label: registered.event.label,
      origin: "provider",
      qualifiers: registered.event.qualifiers ?? [],
      audiences: registered.event.audiences ?? ALLOWLIST,
      ...(registered.event.replyType === undefined
        ? {}
        : { replyType: registered.event.replyType }),
      ...(registered.event.audienceHint === undefined
        ? {}
        : { audienceHint: registered.event.audienceHint }),
    };
  }
  return EVENTS["manual.run"];
}

const PROVIDERS: readonly string[] = [
  "github",
  "slack",
  "discord",
  "linear",
  "manual",
  "schedule",
  "webhook",
];

/**
 * Where an event comes from. An event the editor offers says so itself; a YAML-only event such as
 * `discord.message` is named for its provider, and only an event from no provider Hub knows
 * counts as manual.
 */
export function eventProvider(
  eventId: string,
  registry: BrowserIntegrationRegistry = defaultBrowserIntegrationRegistry,
): string {
  if (isEditorEvent(eventId, registry)) return eventDefinition(eventId, registry).provider;
  const prefix = eventId.split(".")[0];
  if (prefix !== undefined && registry.has(prefix)) return prefix;
  return PROVIDERS.find((provider) => provider === prefix) ?? "manual";
}

/** The audience a new trigger for this event starts with. */
export function defaultAudience(
  eventId: EditorEvent,
  registry: BrowserIntegrationRegistry = defaultBrowserIntegrationRegistry,
): TriggerAudience {
  return eventDefinition(eventId, registry).audiences[0] ?? "everyone";
}

export function automaticReplyType(
  eventId: string,
  registry: BrowserIntegrationRegistry = defaultBrowserIntegrationRegistry,
): string | undefined {
  const registered = registry.forEvent(eventId);
  if (registered !== undefined) return registered.event.replyType;
  const provider = eventId.split(".", 1)[0];
  return provider === "slack" ||
    provider === "discord" ||
    provider === "linear" ||
    provider === "github"
    ? `${provider}.reply`
    : undefined;
}
