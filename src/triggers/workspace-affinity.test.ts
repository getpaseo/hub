import { describe, expect, it } from "vitest";
import {
  providerSupportsWorkspaceAffinityConversationKey,
  triggerSupportsWorkspaceAffinityConversationKey,
} from "./workspace-affinity.js";
import { compileTriggerDocument } from "./configuration/index.js";

describe("workspace conversation identity support", () => {
  it.each(["linear.issue_entered_scope", "linear.issue_assigned", "linear.comment_created"])(
    "compiles an issue-scoped key for %s",
    (event) => {
      expect(providerSupportsWorkspaceAffinityConversationKey("linear")).toBe(true);
      expect(triggerSupportsWorkspaceAffinityConversationKey(event)).toBe(true);
      const compiled = compileTriggerDocument(`
name: linear-work
on:
  ${event}:
    connection: company-linear
    filters: { from_users: [operator], project: project-1 }
run:
  target: { daemon: devbox, cwd: /repo }
  agent: { provider: codex }
  prompt: Handle the request
  workspace_affinity:
    key: "\${{ paseo.trigger.conversation_key }}"
`);
      expect(compiled.events[0]?.steps[0]?.workspaceAffinity).toEqual({
        key: "${{ paseo.trigger.conversation_key }}",
      });
    },
  );

  it.each(["manual.run", "github.push", "linear.unknown", "linear.agent_session_created"])(
    "does not promise a conversation identity before an event is implemented: %s",
    (event) => {
      expect(triggerSupportsWorkspaceAffinityConversationKey(event)).toBe(false);
    },
  );
});
