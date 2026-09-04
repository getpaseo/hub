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

interface EventDefinition {
  provider: "github" | "slack" | "discord" | "linear" | "manual";
  label: string;
  qualifiers: readonly QualifierDefinition[];
}

const ADDED_LABEL: QualifierDefinition = {
  key: "label",
  kind: "string",
  label: "Added label",
  description:
    "Match the label added by this event, not labels already on the issue or pull request.",
  required: true,
};

function event(
  provider: EventDefinition["provider"],
  label: string,
  qualifiers: readonly QualifierDefinition[] = [],
): EventDefinition {
  return { provider, label, qualifiers };
}

const EVENTS = {
  "slack.mention": event("slack", "Slack mention"),
  "discord.mention": event("discord", "Discord mention"),
  "github.issue_created": event("github", "GitHub issue created"),
  "github.pull_request_created": event("github", "GitHub pull request created"),
  "github.issue_comment_created": event("github", "GitHub issue comment created"),
  "github.pull_request_comment_created": event("github", "GitHub pull request comment created"),
  "github.issue_label_added": event("github", "GitHub issue label added", [ADDED_LABEL]),
  "github.pull_request_label_added": event("github", "GitHub pull request label added", [
    ADDED_LABEL,
  ]),
  "github.issue_comment": event("github", "GitHub issue or PR comment webhook"),
  "github.issues": event("github", "GitHub issue webhook"),
  "github.pull_request": event("github", "GitHub pull request webhook"),
  "github.pull_request_review": event("github", "GitHub pull request review webhook"),
  "github.pull_request_review_comment": event("github", "GitHub review comment webhook"),
  "github.push": event("github", "GitHub push"),
  "linear.issue_entered_scope": event("linear", "Linear issue entered scope"),
  "linear.issue_assigned": event("linear", "Linear issue assigned"),
  "linear.comment_created": event("linear", "Linear comment created"),
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
