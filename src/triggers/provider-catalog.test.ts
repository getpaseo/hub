import { describe, expect, it } from "vitest";
import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import { selectedProviderModel } from "./provider-catalog.js";

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
  it("resolves aliases to the model-specific thinking catalog", () => {
    expect(selectedProviderModel(entries, "codex/latest").model?.thinkingOptions).toEqual([
      { id: "xhigh", label: "Extra high" },
    ]);
  });

  it("leaves configured values that are absent from the snapshot unresolved", () => {
    expect(selectedProviderModel(entries, "codex/retired")).toEqual({
      entry: entries[0],
      model: undefined,
    });
  });
});
