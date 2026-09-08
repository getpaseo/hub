import type { TriggerProviderReactionState } from "./index.js";

/**
 * The two phases every chat-provider reaction machine tracks. The state is stored as a plain
 * object in `TriggerProviderReactionState` so it survives serialisation across execution steps.
 */
export type ReactionPhase = "accepted" | "started";

/**
 * Reads the current reaction phase from an opaque `TriggerProviderReactionState`. Returns
 * `undefined` when the state is absent, not an object, or does not carry a recognised phase —
 * callers treat that the same as "no reaction has been posted yet".
 *
 * This is the only place that interprets the phase field. Chat providers (currently Slack and
 * Discord) share the same phase semantics; only their emoji primitives differ.
 */
export function reactionPhase(
  state: TriggerProviderReactionState | undefined,
): ReactionPhase | undefined {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return undefined;
  const phase = (state as Record<string, unknown>)["phase"];
  return phase === "accepted" || phase === "started" ? phase : undefined;
}
