import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";

const NOOP = (): void => {};

import {
  Combobox,
  comboboxLabel,
  comboboxFilter,
  comboboxSelection,
  type ComboboxOption,
} from "./combobox.js";

interface Model extends ComboboxOption {
  provider: string;
}

const MODELS: readonly Model[] = [
  { value: "claude-opus", label: "Opus", detail: "Anthropic", provider: "anthropic" },
  { value: "gpt-5", label: "GPT-5", detail: "OpenAI", provider: "openai" },
];

function trigger(value: string): string {
  return renderToStaticMarkup(
    <Combobox
      id="model"
      value={value}
      options={MODELS}
      onChange={NOOP}
      placeholder="Select a model"
      empty="No models found."
    />,
  );
}

describe("what a combobox selection means", () => {
  it("resolves a stored value to the whole record behind it", () => {
    const selected = comboboxSelection(MODELS, "gpt-5");

    assert.equal(selected?.label, "GPT-5");
    assert.equal(selected?.provider, "openai");
  });

  it("resolves nothing for a value no option offers", () => {
    assert.equal(comboboxSelection(MODELS, "gemini"), undefined);
  });
});

describe("which options a search keeps", () => {
  // Random IDs contain nearly every pair of letters in order: "ac" is in "a-1-c-9f" if the
  // letters may be far apart.
  const organizations: readonly ComboboxOption[] = [
    { value: "acme", label: "Acme", keywords: ["Acme"], identifier: "7f3a-91c2" },
    { value: "globex", label: "Globex", keywords: ["Globex"], identifier: "a-1-c-9f" },
  ];
  const events: readonly ComboboxOption[] = [
    {
      value: "github.pull_request_created",
      label: "GitHub pull request created",
      keywords: ["GitHub pull request created", "github.pull_request_created"],
    },
  ];
  const keeps = (options: readonly ComboboxOption[], value: string, search: string): boolean =>
    comboboxFilter(options)(value, search, [
      ...(options.find((o) => o.value === value)?.keywords ?? []),
    ]) > 0;

  it("keeps an option whose name or identifier contains what was typed", () => {
    assert.equal(keeps(organizations, "acme", "acm"), true);
    assert.equal(keeps(organizations, "acme", "91c2"), true);
    assert.equal(keeps(organizations, "globex", "A-1-C"), true);
  });

  it("does not match an identifier by scattered letters", () => {
    assert.equal(keeps(organizations, "globex", "ac"), false);
  });

  it("ranks a named match above an identifier-only hit, whatever the stored value embeds", () => {
    // The picker stores `<name>-<first 8 ID characters>` as the value.
    const acme: ComboboxOption = {
      value: "acme-q1w2e3r4",
      label: "Acme",
      keywords: ["Acme"],
      identifier: "q1w2e3r4t5y6",
    };
    const zeta: ComboboxOption = {
      value: "zeta-a9c8d7e6",
      label: "Zeta",
      keywords: ["Zeta"],
      identifier: "xxac12345678",
    };
    const filter = comboboxFilter([acme, zeta]);
    const named = filter(acme.value, "ac", ["Acme"]);
    const identifierOnly = filter(zeta.value, "ac", ["Zeta"]);

    assert.ok(identifierOnly > 0, "the identifier-only hit stays findable");
    assert.ok(named > identifierOnly);
    assert.equal(filter("zeta-a9c8d7e6", "zq", ["Zeta"]), 0);
    // A slug pasted from a URL finds its organization; scattered letters of it do not.
    assert.ok(filter(acme.value, "acme-q1w2e3r4", ["Acme"]) > 0);
    assert.ok(filter(acme.value, "acme-q1w2", ["Acme"]) > 0);
    assert.equal(filter(zeta.value, "z9c", ["Zeta"]), 0);
  });

  it("still reads shorthand as letters in order everywhere else", () => {
    assert.equal(keeps(events, "github.pull_request_created", "gh pr"), true);
    assert.equal(keeps(events, "github.pull_request_created", "slack"), false);
  });
});

describe("what the closed combobox reads", () => {
  it("shows the chosen option's label", () => {
    assert.equal(comboboxLabel(MODELS, "claude-opus", "Select a model"), "Opus");
    assert.match(trigger("claude-opus"), />Opus</u);
  });

  it("shows the placeholder when nothing is chosen", () => {
    assert.equal(comboboxLabel(MODELS, "", "Select a model"), "Select a model");
    assert.match(trigger(""), />Select a model</u);
  });

  it("says a stored value has gone away rather than looking unset", () => {
    assert.equal(comboboxLabel(MODELS, "gemini", "Select a model"), "gemini (unavailable)");
    assert.match(trigger("gemini"), />gemini \(unavailable\)</u);
  });

  it("carries the stored value on the trigger, closed and unexpanded", () => {
    const markup = trigger("gpt-5");

    assert.match(markup, /role="combobox"/u);
    assert.match(markup, /data-value="gpt-5"/u);
    assert.match(markup, /aria-expanded="false"/u);
  });
});

describe("what the closed combobox reads while its options are still arriving", () => {
  it("shows the stored value as it is, rather than calling it unavailable", () => {
    assert.equal(comboboxLabel([], "gpt-5", "Select a model", true), "gpt-5");
  });

  it("says it has gone away once the options have arrived without it", () => {
    assert.equal(comboboxLabel(MODELS, "gemini", "Select a model", false), "gemini (unavailable)");
  });

  it("still shows the placeholder when nothing is stored", () => {
    assert.equal(comboboxLabel([], "", "Select a model", true), "Select a model");
  });
});
