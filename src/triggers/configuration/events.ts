/** The YAML filter keys the form knows how to qualify. */
export type QualifierKey = "label";

/** Draft values for the qualifiers declared by the selected event. */
export type QualifierValues = Partial<Record<QualifierKey, string>>;

export interface QualifierDefinition {
  key: QualifierKey;
  kind: "string";
  label: string;
  description: string;
  required: boolean;
}

/**
 * Who may invoke a trigger, as the form offers it. `members` and `contributors` are GitHub
 * repository associations; `everyone` and `specific` are the allowlist every provider has.
 */
export type TriggerAudience = "members" | "contributors" | "everyone" | "specific";

interface EventDefinition {
  provider: "github" | "slack" | "discord" | "linear" | "manual" | "schedule" | "webhook";
  label: string;
  origin: "hub" | "provider";
  qualifiers: readonly QualifierDefinition[];
  /** The audiences the form offers for this event, default first. Empty when Hub is the source. */
  audiences: readonly TriggerAudience[];
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

/** A GitHub event whose actor wrote the issue, pull request, comment, or review it carries. */
function authored(label: string): EventDefinition {
  return event("github", label, { audiences: ASSOCIATION });
}

const EVENTS = {
  "slack.mention": event("slack", "Slack mention"),
  "discord.mention": event("discord", "Discord mention"),
  "github.issue_created": authored("GitHub issue created"),
  "github.pull_request_created": authored("GitHub pull request created"),
  "github.pull_request_ready_for_review": authored("GitHub pull request ready for review"),
  "github.pull_request_synchronized": authored("GitHub pull request updated with new commits"),
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
  "github.issue_comment": authored("GitHub issue or PR comment webhook"),
  "github.issues": authored("GitHub issue webhook"),
  "github.pull_request": authored("GitHub pull request webhook"),
  "github.pull_request_review": authored("GitHub pull request review webhook"),
  "github.pull_request_review_comment": authored("GitHub review comment webhook"),
  // GitHub restricts pushing to writers and reports no association on a push.
  "github.push": event("github", "GitHub push"),
  "linear.issue_entered_scope": event("linear", "Linear issue entered scope"),
  "linear.issue_assigned": event("linear", "Linear issue assigned"),
  "linear.comment_created": event("linear", "Linear comment created"),
  "schedule.tick": event("schedule", "Schedule"),
  "webhook.received": event("webhook", "Webhook received"),
  "manual.run": event("manual", "Manual run"),
};

export type EditorEvent = keyof typeof EVENTS;
export const EDITOR_EVENTS = Object.keys(EVENTS).filter(isEditorEvent);

export function isEditorEvent(value: string): value is EditorEvent {
  return Object.hasOwn(EVENTS, value);
}

export function parseEditorEvent(value: string): EditorEvent {
  return isEditorEvent(value) ? value : "manual.run";
}

export function eventDefinition(eventId: EditorEvent): EventDefinition {
  return EVENTS[eventId];
}

/** The audience a new trigger for this event starts with. */
export function defaultAudience(eventId: EditorEvent): TriggerAudience {
  return EVENTS[eventId].audiences[0] ?? "everyone";
}
