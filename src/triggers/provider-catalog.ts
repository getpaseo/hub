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
  const previousProvider = previous.entry?.provider ?? safeProviderOf(input.form.agent);
  const nextProvider = selected.entry?.provider ?? safeProviderOf(input.agent);
  const sameProvider = previousProvider !== undefined && previousProvider === nextProvider;
  const switchedProvider = previousProvider !== undefined && previousProvider !== nextProvider;
  const sameModel = sameProvider && previous.model?.id === selected.model?.id;
  return {
    ...input.form,
    agent: input.agent,
    mode: pickMode(selected.entry, sameProvider ? input.form.mode : undefined),
    thinkingOptionId: pickThinking(
      selected.model,
      sameModel ? input.form.thinkingOptionId : undefined,
    ),
    ...(switchedProvider ? { providerOptions: "" } : {}),
  };
}

function pickMode(
  entry: HubProviderSnapshotEntry | undefined,
  currentMode: string | undefined,
): string {
  const modes = entry?.modes ?? [];
  const chosen =
    modes.find((candidate) => candidate.id === currentMode) ??
    modes.find((candidate) => candidate.id === entry?.defaultModeId) ??
    modes[0];
  return chosen?.id ?? "";
}

function pickThinking(
  model: NonNullable<HubProviderSnapshotEntry["models"]>[number] | undefined,
  currentThinking: string | undefined,
): string {
  const options = model?.thinkingOptions ?? [];
  const chosen =
    options.find((candidate) => candidate.id === currentThinking) ??
    options.find((candidate) => candidate.id === model?.defaultThinkingOptionId) ??
    options[0];
  return chosen?.id ?? "";
}

function safeProviderOf(agent: string): string | undefined {
  if (agent.trim() === "") return undefined;
  try {
    return splitAgentId(agent).provider;
  } catch {
    return undefined;
  }
}
