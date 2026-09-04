import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";

const NOOP = (): void => {};

import { SegmentedControl, nextSegmentValue, type SegmentedOption } from "./segmented-control.js";

const MODES: readonly SegmentedOption[] = [
  { value: "form", label: "Form" },
  { value: "yaml", label: "YAML" },
];

const WITH_DISABLED: readonly SegmentedOption[] = [
  { value: "form", label: "Form" },
  { value: "legacy", label: "Legacy", disabled: true },
  { value: "yaml", label: "YAML" },
];

describe("segmented control keyboard movement", () => {
  it("moves forwards and backwards with either axis of arrow keys", () => {
    assert.equal(nextSegmentValue(MODES, "form", "ArrowRight"), "yaml");
    assert.equal(nextSegmentValue(MODES, "form", "ArrowDown"), "yaml");
    assert.equal(nextSegmentValue(MODES, "yaml", "ArrowLeft"), "form");
    assert.equal(nextSegmentValue(MODES, "yaml", "ArrowUp"), "form");
  });

  it("wraps at the ends, the way a radio group does everywhere else", () => {
    assert.equal(nextSegmentValue(MODES, "yaml", "ArrowRight"), "form");
    assert.equal(nextSegmentValue(MODES, "form", "ArrowLeft"), "yaml");
  });

  it("steps over a disabled option instead of landing on one it would refuse", () => {
    assert.equal(nextSegmentValue(WITH_DISABLED, "form", "ArrowRight"), "yaml");
    assert.equal(nextSegmentValue(WITH_DISABLED, "yaml", "ArrowLeft"), "form");
  });

  it("jumps to the ends with Home and End", () => {
    assert.equal(nextSegmentValue(WITH_DISABLED, "yaml", "Home"), "form");
    assert.equal(nextSegmentValue(WITH_DISABLED, "form", "End"), "yaml");
  });

  it("answers to nothing else, so typing in the page still reaches the page", () => {
    assert.equal(nextSegmentValue(MODES, "form", "Enter"), undefined);
    assert.equal(nextSegmentValue(MODES, "form", "a"), undefined);
    assert.equal(nextSegmentValue(MODES, "form", "Home"), undefined);
  });
});

describe("segmented control semantics", () => {
  it("is a named radio group of radios, not a row of buttons", () => {
    const markup = renderToStaticMarkup(
      <SegmentedControl label="Editor mode" value="yaml" options={MODES} onChange={NOOP} />,
    );

    assert.match(markup, /role="radiogroup"/u);
    assert.match(markup, /aria-label="Editor mode"/u);
    assert.equal(markup.match(/role="radio"/gu)?.length, MODES.length);
    assert.equal(markup.match(/aria-checked="true"/gu)?.length, 1);
  });

  it("is one stop in the tab order: only the checked option is tabbable", () => {
    const markup = renderToStaticMarkup(
      <SegmentedControl label="Editor mode" value="yaml" options={MODES} onChange={NOOP} />,
    );

    assert.equal(markup.match(/tabindex="0"/gu)?.length, 1);
    assert.equal(markup.match(/tabindex="-1"/gu)?.length, MODES.length - 1);
  });
});
