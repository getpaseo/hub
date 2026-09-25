/** The YAML filter keys the form knows how to qualify. */
export type QualifierKey = "label" | "assignees" | "reviewers" | "branches";

/** Draft values for the qualifiers declared by the selected event. Always the form's
 * text spelling, comma-separated for a `list` qualifier, same as `allowedUsers`. */
export type QualifierValues = Partial<Record<QualifierKey, string>>;

export interface QualifierDefinition {
  key: QualifierKey;
  kind: "string";
  /** The underlying filter is `string[]`, entered and displayed comma-separated. */
  list?: boolean;
  label: string;
  description: string;
  required: boolean;
}

interface EventDefinition {
  provider: "github" | "slack" | "discord" | "linear" | "forgejo" | "manual" | "schedule";
  label: string;
  origin: "hub" | "provider";
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

const ADDED_ASSIGNEES: QualifierDefinition = {
  key: "assignees",
  kind: "string",
  list: true,
  label: "Assignees",
  description:
    "Match when the login added by this event is one of these, comma separated. Leave blank to match any assignee.",
  required: false,
};

const PUSH_BRANCHES: QualifierDefinition = {
  key: "branches",
  kind: "string",
  list: true,
  label: "Branches",
  description:
    "Match when the pushed branch is one of these, comma separated (exact, case sensitive; * matches any branch, but never a tag). Leave blank to match any branch.",
  required: false,
};

const REQUESTED_REVIEWERS: QualifierDefinition = {
  key: "reviewers",
  kind: "string",
  list: true,
  label: "Reviewers",
  description:
    "Match when the reviewer this event requests is one of these, comma separated. Leave blank to match any requested reviewer.",
  required: false,
};

function event(
  provider: EventDefinition["provider"],
  label: string,
  qualifiers: readonly QualifierDefinition[] = [],
): EventDefinition {
  return {
    provider,
    label,
    qualifiers,
    origin: provider === "manual" || provider === "schedule" ? "hub" : "provider",
  };
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
  "forgejo.issue_created": event("forgejo", "Forgejo issue created"),
  "forgejo.pull_request_created": event("forgejo", "Forgejo pull request created"),
  "forgejo.issue_comment_created": event("forgejo", "Forgejo issue comment created"),
  "forgejo.pull_request_comment_created": event("forgejo", "Forgejo pull request comment created"),
  "forgejo.issue_label_added": event("forgejo", "Forgejo issue label added", [ADDED_LABEL]),
  "forgejo.pull_request_label_added": event("forgejo", "Forgejo pull request label added", [
    ADDED_LABEL,
  ]),
  "forgejo.issue_assigned": event("forgejo", "Forgejo issue assigned", [ADDED_ASSIGNEES]),
  "forgejo.pull_request_assigned": event("forgejo", "Forgejo pull request assigned", [
    ADDED_ASSIGNEES,
  ]),
  "forgejo.pull_request_review_approved": event("forgejo", "Forgejo pull request review approved"),
  "forgejo.pull_request_review_rejected": event("forgejo", "Forgejo pull request review rejected"),
  "forgejo.pull_request_review_requested": event(
    "forgejo",
    "Forgejo pull request review requested",
    [REQUESTED_REVIEWERS],
  ),
  "forgejo.issue_closed": event("forgejo", "Forgejo issue closed"),
  "forgejo.issue_reopened": event("forgejo", "Forgejo issue reopened"),
  "forgejo.pull_request_closed": event("forgejo", "Forgejo pull request closed"),
  "forgejo.pull_request_merged": event("forgejo", "Forgejo pull request merged"),
  "forgejo.pull_request_reopened": event("forgejo", "Forgejo pull request reopened"),
  "forgejo.pull_request_synchronized": event("forgejo", "Forgejo pull request synchronized"),
  "forgejo.action_run_failure": event("forgejo", "Forgejo CI run failed"),
  "forgejo.action_run_success": event("forgejo", "Forgejo CI run succeeded"),
  "forgejo.issue_comment": event("forgejo", "Forgejo issue or PR comment webhook"),
  "forgejo.issues": event("forgejo", "Forgejo issue webhook"),
  "forgejo.pull_request": event("forgejo", "Forgejo pull request webhook"),
  "forgejo.pull_request_review": event("forgejo", "Forgejo pull request review webhook"),
  "forgejo.push": event("forgejo", "Forgejo push", [PUSH_BRANCHES]),
  "linear.issue_entered_scope": event("linear", "Linear issue entered scope"),
  "linear.issue_assigned": event("linear", "Linear issue assigned"),
  "linear.comment_created": event("linear", "Linear comment created"),
  "schedule.tick": event("schedule", "Schedule"),
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
