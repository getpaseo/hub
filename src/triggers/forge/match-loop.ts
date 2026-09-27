import type { CompiledTriggerConfig } from "../../config/index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import type { TriggerProviderMatch } from "../index.js";
import type { Conversation } from "../continuation.js";
import { readForgeMentionFromMessage, readForgeParserMessage } from "./match.js";

export interface ForgeMatchContext<TTriggerContext, TOutputContext> {
  triggerContext: TTriggerContext;
  outputContext: TOutputContext;
  conversation: Conversation | null;
}

/**
 * The part of a forge provider's `match()` that GitHub and Forgejo share: resolve
 * each matched trigger, parse the invocation, drop ones that fail their `inputs`
 * filter. `contextFor` closes over whatever the provider's own `match()` already
 * computed, since triggerContext/outputContext differ per provider.
 */
export function buildForgeTriggerMatches<TTriggerContext, TOutputContext>(input: {
  matches: readonly { trigger: { name: string } }[];
  triggers: readonly CompiledTriggerConfig[];
  message: string;
  revisionId: string;
  hubConfig: unknown;
  contextFor(
    compiledTrigger: CompiledTriggerConfig,
  ): ForgeMatchContext<TTriggerContext, TOutputContext>;
}): TriggerProviderMatch<TTriggerContext, TOutputContext>[] | "trigger_filters_rejected" {
  const matches: TriggerProviderMatch<TTriggerContext, TOutputContext>[] = [];

  for (const match of input.matches) {
    const compiledTrigger = input.triggers.find(
      (candidate) => candidate.name === match.trigger.name,
    );
    if (compiledTrigger === undefined) {
      throw new Error(`compiled trigger not found: ${match.trigger.name}`);
    }

    const { triggerContext, outputContext, conversation } = input.contextFor(compiledTrigger);
    const invocation = parseInvocation(
      input.message,
      compiledTrigger.inputs,
      readForgeMentionFromMessage(input.message, compiledTrigger.filters),
      readForgeParserMessage(input.message, compiledTrigger.filters),
    );
    const common = {
      conversation,
      triggerName: match.trigger.name,
      triggerContext,
      outputContext,
      configurationRevisionId: input.revisionId,
      hubConfig: input.hubConfig,
    };

    // separate push per branch so invocation stays narrowed; hoisting the push
    // widens it back to the full union and needs a cast.
    if (invocation.status === "accepted") {
      if (matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) {
        matches.push({ ...common, invocation });
      }
      continue;
    }
    matches.push({ ...common, invocation });
  }

  return matches.length === 0 ? "trigger_filters_rejected" : matches;
}
