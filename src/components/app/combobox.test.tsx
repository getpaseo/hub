import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";

const NOOP = (): void => {};

import { Combobox, comboboxLabel, comboboxSelection, type ComboboxOption } from "./combobox.js";

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
