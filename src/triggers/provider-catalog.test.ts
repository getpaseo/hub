import { TriggerDocumentSchema } from "./configuration/schema.js";
import { projectTriggerForm, createTriggerYaml } from "./configuration/editor.js";
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import {
  changeTriggerModel,
  providerCatalogFailure,
  selectedProviderModel,
} from "./provider-catalog.js";

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

it("clears provider options when switching providers and keeps them when switching models on the same provider", () => {
  const catalog: HubProviderSnapshotEntry[] = [
    {
      ...entries[0]!,
      models: [
        ...entries[0]!.models!,
        { provider: "codex", id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
      ],
    },
    {
      provider: "claude",
      label: "Claude",
      status: "ready",
      enabled: true,
      modes: [{ id: "bypassPermissions", label: "Full access" }],
      defaultModeId: "bypassPermissions",
      models: [{ provider: "claude", id: "claude-opus-4-7", label: "Opus 4.7" }],
    },
  ];
  const withOptions = {
    ...existingForm(),
    providerOptions: '{\n  "service_tier": "fast",\n  "sandbox_mode": "workspace-write"\n}',
  };
  const sameProvider = changeTriggerModel({
    entries: catalog,
    form: withOptions,
    agent: "codex/gpt-5.4-mini",
  });
  expect(sameProvider.providerOptions).toBe(withOptions.providerOptions);

  const differentProvider = changeTriggerModel({
    entries: catalog,
    form: withOptions,
    agent: "claude/claude-opus-4-7",
  });
  expect(differentProvider.providerOptions).toBe("");
});

describe("what the agent step says about providers that failed", () => {
  const claude: HubProviderSnapshotEntry = {
    provider: "claude",
    label: "Claude",
    status: "ready",
    enabled: true,
    models: [{ provider: "claude", id: "opus", label: "Opus" }],
  };
  const codex: HubProviderSnapshotEntry = {
    provider: "codex",
    label: "Codex",
    status: "error",
    enabled: true,
    error: "spawn codex ENOENT",
  };
  const opencode: HubProviderSnapshotEntry = {
    provider: "opencode",
    status: "error",
    enabled: true,
  };

  it("says nothing about a provider that failed while another offers models", () => {
    expect(providerCatalogFailure([claude, codex], "")).toBeUndefined();
    expect(providerCatalogFailure([claude, codex], "claude/opus")).toBeUndefined();
  });

  it("names every failed provider when none offers a model", () => {
    expect(providerCatalogFailure([codex, opencode], "")).toBe(
      "Codex: spawn codex ENOENT opencode: unavailable",
    );
    expect(
      providerCatalogFailure(
        [{ ...claude, models: [{ ...claude.models![0]!, isSelectable: false }] }, codex],
        "",
      ),
    ).toBe("Codex: spawn codex ENOENT");
  });

  it("names the chosen provider when it is the one that failed", () => {
    expect(providerCatalogFailure([claude, codex, opencode], "codex/gpt-5.4")).toBe(
      "Codex: spawn codex ENOENT",
    );
  });

  it("says nothing while the daemon has not answered or reports no failure", () => {
    expect(providerCatalogFailure(undefined, "")).toBeUndefined();
    expect(providerCatalogFailure([claude], "")).toBeUndefined();
  });
});
