import { describe, expect, it } from "vitest";
import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import { defaultAgentSelection, defaultMode, selectedProviderModel } from "./provider-catalog.js";

const entries: HubProviderSnapshotEntry[] = [
  {
    provider: "codex",
    label: "Codex",
    status: "ready",
    enabled: true,
    defaultModeId: "full-access",
    modes: [
      { id: "read-only", label: "Read only" },
      { id: "full-access", label: "Full access" },
    ],
    models: [
      { provider: "codex", id: "small", label: "Small", isSelectable: false },
      {
        provider: "codex",
        id: "gpt-5.4",
        aliases: ["latest"],
        label: "GPT-5.4",
        isDefault: true,
        thinkingOptions: [{ id: "xhigh", label: "Extra high" }],
      },
    ],
  },
];

describe("trigger provider catalog", () => {
  it("selects daemon defaults without hard-coding a provider", () => {
    expect(defaultAgentSelection(entries)).toEqual({
      agent: "codex/gpt-5.4",
      mode: "full-access",
      thinkingOptionId: "",
    });
  });

  it("resolves aliases to the model-specific thinking catalog", () => {
    expect(selectedProviderModel(entries, "codex/latest").model?.thinkingOptions).toEqual([
      { id: "xhigh", label: "Extra high" },
    ]);
  });

  it("uses the first reported mode when the provider has no explicit default", () => {
    expect(defaultMode({ ...entries[0]!, defaultModeId: null })).toBe("read-only");
  });

  it("leaves configured values that are absent from the snapshot unresolved", () => {
    expect(selectedProviderModel(entries, "codex/retired")).toEqual({
      entry: entries[0],
      model: undefined,
    });
  });
});
