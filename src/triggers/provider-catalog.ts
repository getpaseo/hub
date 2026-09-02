import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import { splitAgentId, type TriggerFormValue } from "./configuration/editor.js";

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

export function defaultMode(entry: HubProviderSnapshotEntry | undefined): string {
  const explicit = entry?.modes?.find((mode) => mode.id === entry.defaultModeId);
  if (explicit !== undefined) return explicit.id;
  return entry?.modes?.[0]?.id ?? "";
}

export function defaultAgentSelection(
  entries: HubProviderSnapshotEntry[],
): Pick<TriggerFormValue, "agent" | "mode" | "thinkingOptionId"> | undefined {
  for (const entry of entries) {
    if (entry.status !== "ready" || !entry.enabled) continue;
    const models = (entry.models ?? []).filter((model) => model.isSelectable !== false);
    const model = models.find((candidate) => candidate.isDefault) ?? models[0];
    if (model === undefined) continue;
    return {
      agent: `${entry.provider}/${model.id}`,
      mode: defaultMode(entry),
      thinkingOptionId: "",
    };
  }
  return undefined;
}
