import type { AcceptLinearEventInput } from "./types.js";

export function isLinearAgentSessionStop(
  input: Pick<AcceptLinearEventInput, "source" | "payload">,
): boolean {
  if (input.source !== "linear.agent_session" || !isRecord(input.payload)) return false;
  const activity = input.payload["agentActivity"];
  return (
    input.payload["type"] === "agent_session" && isRecord(activity) && activity["signal"] === "stop"
  );
}

export function linearAgentSessionStopId(
  input: Pick<AcceptLinearEventInput, "source" | "payload">,
): string | undefined {
  if (!isLinearAgentSessionStop(input) || !isRecord(input.payload)) return undefined;
  const session = input.payload["agentSession"];
  if (!isRecord(session)) return undefined;
  const id = session["id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
