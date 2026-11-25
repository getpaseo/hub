import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { HubAgentOptionControl } from "../hub/protocol.js";
import {
  describeActiveProviderOptions,
  effectiveProviderOptions,
  isControlActive,
  parseFormProviderOptions,
  ProviderOptionControls,
  pruneLostProviderOptions,
  readSelectOption,
  readToggleOption,
  updateFormProviderOption,
} from "./provider-options.js";

const SPEED_CONTROL: HubAgentOptionControl = {
  type: "select",
  key: "service_tier",
  label: "Speed",
  description: "Choose processing speed",
  defaultValue: "default",
  choices: [
    { value: "default", label: "Normal" },
    { value: "flex", label: "Flex", description: "Slower processing, reduced usage" },
    { value: "fast", label: "Fast", description: "Faster processing, higher usage" },
  ],
};

const PLAN_CONTROL: HubAgentOptionControl = {
  type: "toggle",
  key: "plan_mode",
  label: "Plan",
  description: "Switch Codex into planning-only collaboration mode",
};

const ULTRACODE_CONTROL: HubAgentOptionControl = {
  type: "toggle",
  key: "ultracode",
  label: "Ultracode",
};

describe("provider option control helpers", () => {
  test("reads toggle and select values with Paseo default semantics", () => {
    expect(readToggleOption(PLAN_CONTROL, {})).toBe(false);
    expect(readToggleOption(PLAN_CONTROL, { plan_mode: true })).toBe(true);
    expect(readToggleOption({ ...PLAN_CONTROL, defaultValue: true }, {})).toBe(true);
    expect(readToggleOption({ ...PLAN_CONTROL, defaultValue: true }, { plan_mode: false })).toBe(
      false,
    );

    expect(readSelectOption(SPEED_CONTROL, {})).toBe("default");
    expect(readSelectOption(SPEED_CONTROL, { service_tier: "fast" })).toBe("fast");
    expect(readSelectOption(SPEED_CONTROL, { service_tier: "unknown" })).toBe("default");
  });

  test("summarizes only non-default active provider options", () => {
    const controls = [SPEED_CONTROL, PLAN_CONTROL];
    expect(isControlActive(SPEED_CONTROL, { service_tier: "default" })).toBe(false);
    expect(isControlActive(SPEED_CONTROL, { service_tier: "fast" })).toBe(true);
    expect(isControlActive(PLAN_CONTROL, {})).toBe(false);
    expect(isControlActive(PLAN_CONTROL, { plan_mode: true })).toBe(true);

    expect(describeActiveProviderOptions(controls, {})).toEqual([]);
    expect(
      describeActiveProviderOptions(controls, { service_tier: "fast", plan_mode: true }),
    ).toEqual(["Speed: Fast", "Plan"]);
    expect(
      describeActiveProviderOptions(controls, { service_tier: "default", plan_mode: false }),
    ).toEqual([]);
  });

  test("updates one option key while preserving unmodeled keys in form JSON", () => {
    expect(updateFormProviderOption("", "service_tier", "fast")).toBe(
      '{\n  "service_tier": "fast"\n}',
    );
    const existing = '{\n  "sandbox_mode": "workspace-write",\n  "approval_policy": "never"\n}';
    expect(parseFormProviderOptions(updateFormProviderOption(existing, "plan_mode", true))).toEqual(
      {
        sandbox_mode: "workspace-write",
        approval_policy: "never",
        plan_mode: true,
      },
    );
  });

  test("prunes lost drawn controls and unsupported select choices while keeping unmodeled options", () => {
    const raw = JSON.stringify(
      {
        sandbox_mode: "workspace-write",
        ultracode: true,
        service_tier: "fast",
      },
      null,
      2,
    );

    // Initial open (no drawn keys yet): never mutates existing options.
    expect(
      pruneLostProviderOptions({
        raw,
        drawnKeys: new Set(),
        controls: [],
      }),
    ).toBe(raw);

    // Switching to a model without `ultracode` and with a narrower `service_tier` choice list:
    const narrowedSpeed: HubAgentOptionControl = {
      ...SPEED_CONTROL,
      choices: [
        { value: "default", label: "Normal" },
        { value: "flex", label: "Flex" },
      ],
    };
    const pruned = pruneLostProviderOptions({
      raw,
      drawnKeys: new Set(["ultracode", "service_tier"]),
      controls: [narrowedSpeed],
    });
    expect(parseFormProviderOptions(pruned)).toEqual({
      sandbox_mode: "workspace-write",
    });

    // When all keys were drawn controls that disappeared, clears to empty string.
    expect(
      pruneLostProviderOptions({
        raw: JSON.stringify({ ultracode: true }),
        drawnKeys: new Set(["ultracode"]),
        controls: [],
      }),
    ).toBe("");
  });

  test("keeps controls mounted across option edits in the same scope and hides them across scope changes", () => {
    const resolved = {
      scopeKey: "d1|/repo|codex|gpt-5.4|full-access|high",
      requestKey: "d1|/repo|codex|gpt-5.4|full-access|high|{}",
      requestedOptions: {},
      controls: [SPEED_CONTROL, PLAN_CONTROL],
      options: { service_tier: "default" },
    };

    // Exact match uses daemon-resolved options.
    expect(
      effectiveProviderOptions({
        resolved,
        currentScopeKey: resolved.scopeKey,
        currentRequestKey: resolved.requestKey,
        currentOptions: undefined,
      }),
    ).toEqual({
      controls: [SPEED_CONTROL, PLAN_CONTROL],
      options: { service_tier: "default" },
    });

    // In-flight option edit in same scope overlays new value without dropping controls.
    expect(
      effectiveProviderOptions({
        resolved,
        currentScopeKey: resolved.scopeKey,
        currentRequestKey: "d1|/repo|codex|gpt-5.4|full-access|high|fast",
        currentOptions: { service_tier: "fast", plan_mode: true },
      }),
    ).toEqual({
      controls: [SPEED_CONTROL, PLAN_CONTROL],
      options: { service_tier: "fast", plan_mode: true },
    });

    // Scope change (new model/provider) clears controls until new answer arrives.
    expect(
      effectiveProviderOptions({
        resolved,
        currentScopeKey: "d1|/repo|claude|claude-opus-4-7|bypassPermissions|",
        currentRequestKey: "d1|/repo|claude|claude-opus-4-7|bypassPermissions||{}",
        currentOptions: undefined,
      }),
    ).toEqual({
      controls: [],
      options: {},
    });
  });
});

const NOOP = () => {};
const NO_CONTROLS: readonly HubAgentOptionControl[] = [];
const ALL_CONTROLS: readonly HubAgentOptionControl[] = [
  SPEED_CONTROL,
  PLAN_CONTROL,
  ULTRACODE_CONTROL,
];
const CODEX_CONTROLS: readonly HubAgentOptionControl[] = [SPEED_CONTROL, PLAN_CONTROL];
const EMPTY_OPTIONS = {};
const ACTIVE_OPTIONS = { service_tier: "fast", plan_mode: true };

describe("provider option controls rendering", () => {
  test("renders nothing when the daemon exposes no controls", () => {
    const markup = renderToStaticMarkup(
      <ProviderOptionControls controls={NO_CONTROLS} options={EMPTY_OPTIONS} onSetOption={NOOP} />,
    );
    expect(markup).toBe("");
  });

  test("renders select comboboxes and toggle checkboxes from daemon controls", () => {
    const markup = renderToStaticMarkup(
      <ProviderOptionControls
        controls={ALL_CONTROLS}
        options={ACTIVE_OPTIONS}
        onSetOption={NOOP}
      />,
    );
    expect(markup).toContain("Speed");
    expect(markup).toContain("Fast");
    expect(markup).toContain("Plan");
    expect(markup).toContain("Switch Codex into planning-only collaboration mode");
    expect(markup).toContain("Ultracode");
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('type="checkbox"');
  });

  test("disables controls when raw provider options JSON is invalid", () => {
    const markup = renderToStaticMarkup(
      <ProviderOptionControls
        controls={CODEX_CONTROLS}
        options={EMPTY_OPTIONS}
        disabled
        onSetOption={NOOP}
      />,
    );
    expect(markup).toContain("disabled");
  });
});
