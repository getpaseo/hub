import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import { splitAgentId } from "./configuration/editor.js";

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
