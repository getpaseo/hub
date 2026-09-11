const CONVERSATION_KEY_PROVIDERS = new Set(["github", "slack", "discord", "linear"]);
const CONVERSATION_KEY_TRIGGER_EVENTS = new Set([
  "github.issue_comment",
  "github.issues",
  "github.pull_request",
  "github.pull_request_review",
  "github.pull_request_review_comment",
  "github.issue_created",
  "github.pull_request_created",
  "github.issue_comment_created",
  "github.pull_request_comment_created",
  "github.issue_label_added",
  "github.pull_request_label_added",
  "slack.mention",
  "discord.mention",
  "linear.issue_entered_scope",
  "linear.issue_assigned",
  "linear.comment_created",
]);

export function providerSupportsWorkspaceAffinityConversationKey(provider: string): boolean {
  return CONVERSATION_KEY_PROVIDERS.has(provider);
}

export function triggerSupportsWorkspaceAffinityConversationKey(eventName: string): boolean {
  return CONVERSATION_KEY_TRIGGER_EVENTS.has(eventName);
}
