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
