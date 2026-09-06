import type { AcceptedTriggerProviderMatch } from "../index.js";

const SESSION_PREFIX = "linear.agent_session:";

export function linearAgentSessionConversationKey(agentSessionId: string): string {
  return `${SESSION_PREFIX}${agentSessionId}`;
}

export function conversationKeyFromOutputContext(outputContext: unknown): string | undefined {
  if (!isRecord(outputContext)) return undefined;
  if (outputContext["provider"] !== "linear") return undefined;
  const agentSessionId = outputContext["agentSessionId"];
  return typeof agentSessionId === "string" && agentSessionId.length > 0
    ? linearAgentSessionConversationKey(agentSessionId)
    : undefined;
}

export function isLinearAgentSessionPrompted(triggerContext: unknown): boolean {
  if (!isRecord(triggerContext) || triggerContext["provider"] !== "linear") return false;
  const event = isRecord(triggerContext["event"]) ? triggerContext["event"] : undefined;
  const linear = event !== undefined && isRecord(event["linear"]) ? event["linear"] : undefined;
  return linear?.["event_type"] === "agent_session" && linear["action"] === "prompted";
}

export function linearAgentSessionFollowUpPrompt(match: AcceptedTriggerProviderMatch): string {
  const prompt = match.invocation.prompt.trim();
  const context = readPromptContext(match.triggerContext);
  const lines = [
    "Follow-up in the same Linear agent session.",
    "",
    "Use hub.reply for your user-facing answer. Do not call hub.finish_execution; this session stays open for more replies.",
    "",
    "Request:",
    prompt.length === 0 ? "(empty follow-up)" : prompt,
  ];
  if (context !== undefined) {
    lines.push("", "Context:", context);
  }
  return lines.join("\n");
}

function readPromptContext(triggerContext: unknown): string | undefined {
  if (!isRecord(triggerContext)) return undefined;
  const event = isRecord(triggerContext["event"]) ? triggerContext["event"] : undefined;
  const linear = event !== undefined && isRecord(event["linear"]) ? event["linear"] : undefined;
  const context = linear?.["prompt_context"];
  return typeof context === "string" && context.trim().length > 0 ? context : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
