import { TriggerDocumentSchema } from "./configuration/schema.js";
import { projectTriggerForm, createTriggerYaml } from "./configuration/editor.js";
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import { changeTriggerModel, selectedProviderModel } from "./provider-catalog.js";

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

function existingForm() {
  const projected = projectTriggerForm(`name: selection
on: { manual.run: {} }
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, model: gpt-5.4, mode: read-only }
  prompt: Handle the task
`);
  if (projected.status !== "editable") throw new Error(projected.reason);
  return projected.value;
}

it("materializes the advertised preferred mode and thinking option when a model is chosen", () => {
  const form = changeTriggerModel({
    entries,
    form: { ...existingForm(), agent: "", mode: "", thinkingOptionId: "" },
    agent: "codex/gpt-5.4",
  });
  expect(form).toMatchObject({
    agent: "codex/gpt-5.4",
    mode: "full-access",
    thinkingOptionId: "xhigh",
  });
  expect(
    TriggerDocumentSchema.parse(parseDocument(createTriggerYaml(form)).toJS()).run.agent,
  ).toMatchObject({
    provider: "codex",
    model: "gpt-5.4",
    mode: "full-access",
    thinkingOptionId: "xhigh",
  });
});

it("keeps a concrete mode the user already chose for the same provider", () => {
  expect(changeTriggerModel({ entries, form: existingForm(), agent: "codex/gpt-5.4" }).mode).toBe(
    "read-only",
  );
});

it("chooses a reported mode rather than inventing an unadvertised preferred value", () => {
  expect(
    changeTriggerModel({
      entries: [{ ...entries[0]!, defaultModeId: "missing" }],
      form: { ...existingForm(), agent: "", mode: "" },
      agent: "codex/gpt-5.4",
    }).mode,
  ).toBe("read-only");
});
