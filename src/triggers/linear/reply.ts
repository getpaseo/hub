import { z } from "zod";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { LinearApiClient } from "../../providers/linear/client.js";
import type { LinearAgentSessionTracker } from "./agent-session.js";

const LinearReplyArgsSchema = z.object({ content: z.string().min(1) });

const LinearIssueReplyContextSchema = z.object({
  provider: z.literal("linear"),
  issueId: z.string().min(1),
  linearOrganizationId: z.string().min(1),
});

const LinearAgentSessionReplyContextSchema = z.object({
  provider: z.literal("linear"),
  agentSessionId: z.string().min(1),
  linearOrganizationId: z.string().min(1),
});

/**
 * Emits the agent's user-facing text. Inside an agent session that is a `response` activity, which
 * is what Linear renders as the answer and what moves the session out of its working state; every
 * other Linear trigger still gets a plain issue comment.
 */
export function createLinearReplyExecutor(options: {
  client: LinearApiClient;
  tracker?: LinearAgentSessionTracker;
}): OutputExecutor {
  return async function executeLinearReply(input) {
    const args = LinearReplyArgsSchema.parse(input.args);
    const session = LinearAgentSessionReplyContextSchema.safeParse(input.outputContext);
    if (session.success) {
      await options.client.createAgentActivity({
        linearOrganizationId: session.data.linearOrganizationId,
        agentSessionId: session.data.agentSessionId,
        content: { type: "response", body: args.content },
      });
      options.tracker?.markResponded(session.data.agentSessionId);
      return;
    }
    const context = LinearIssueReplyContextSchema.parse(input.outputContext);
    await options.client.createComment({
      linearOrganizationId: context.linearOrganizationId,
      issueId: context.issueId,
      body: args.content,
    });
  };
}
