import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import { type TriggerFormValue, splitAgentId } from "./configuration/editor.js";

export function selectedProviderModel(
  entries: HubProviderSnapshotEntry[] | undefined,
  agent: string,
) {
  let selection: { provider: string; model?: string } | undefined;
  try {
    selection = agent === "" ? undefined : splitAgentId(agent);
  } catch {
    selection = undefined;
  }
  const entry = entries?.find((candidate) => candidate.provider === selection?.provider);
  return {
    entry,
    model: entry?.models?.find(
      (candidate) =>
        candidate.id === selection?.model || candidate.aliases?.includes(selection?.model ?? ""),
    ),
  };
}

/** The models a reader can pick from one provider: none while it is not ready or is switched off. */
export function selectableModels(entry: HubProviderSnapshotEntry) {
  if (entry.status !== "ready" || !entry.enabled) return [];
  return (entry.models ?? []).filter((model) => model.isSelectable !== false);
}

/**
 * The provider failures that stand between the reader and an agent, said as one line.
 *
 * A daemon reports every provider it knows, installed or not, so a provider that failed is only
 * news when it is the one the trigger names, or when no provider has a model to offer. Otherwise
 * the reader picks from the providers that work and never needed the other one.
 */
export function providerCatalogFailure(
  entries: HubProviderSnapshotEntry[] | undefined,
  agent: string,
): string | undefined {
  const failed = blockingFailures(entries ?? [], agent);
  if (failed.length === 0) return undefined;
  return failed
    .map((entry) => `${entry.label ?? entry.provider}: ${entry.error ?? "unavailable"}`)
    .join(" ");
}

function blockingFailures(entries: HubProviderSnapshotEntry[], agent: string) {
  const { entry } = selectedProviderModel(entries, agent);
  if (entry?.status === "error") return [entry];
  if (entries.some((candidate) => selectableModels(candidate).length > 0)) return [];
  return entries.filter((candidate) => candidate.status === "error");
}

/** A model choice materializes the daemon's advertised selections into the form. */
export function changeTriggerModel(input: {
  entries: HubProviderSnapshotEntry[];
  form: TriggerFormValue;
  agent: string;
}): TriggerFormValue {
  const previous = selectedProviderModel(input.entries, input.form.agent);
  const selected = selectedProviderModel(input.entries, input.agent);
  const modes = selected.entry?.modes ?? [];
  const sameProvider = previous.entry?.provider === selected.entry?.provider;
  const mode =
    (sameProvider ? modes.find((candidate) => candidate.id === input.form.mode) : undefined) ??
    modes.find((candidate) => candidate.id === selected.entry?.defaultModeId) ??
    modes[0];
  const thinkingOptions = selected.model?.thinkingOptions ?? [];
  const sameModel = sameProvider && previous.model?.id === selected.model?.id;
  const thinking =
    (sameModel
      ? thinkingOptions.find((candidate) => candidate.id === input.form.thinkingOptionId)
      : undefined) ??
    thinkingOptions.find((candidate) => candidate.id === selected.model?.defaultThinkingOptionId) ??
    thinkingOptions[0];
  return {
    ...input.form,
    agent: input.agent,
    mode: mode?.id ?? "",
    thinkingOptionId: thinking?.id ?? "",
  };
}
