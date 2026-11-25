/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop -- each provider control binds its own daemon-defined key and choices */
import { CheckboxField } from "../components/app/checkbox-field.js";
import { Combobox, type ComboboxOption } from "../components/app/combobox.js";
import { FormField } from "../components/app/form-field.js";
import {
  JsonValueSchema,
  type HubAgentOptionControl,
  type HubAgentOptionSelectControl,
  type HubAgentOptionToggleControl,
  type WireJsonValue,
} from "../hub/protocol.js";

export type ProviderOptionMap = Record<string, WireJsonValue>;

export interface ResolvedProviderControls {
  scopeKey: string;
  requestKey: string;
  requestedOptions: ProviderOptionMap;
  controls: readonly HubAgentOptionControl[];
  options: ProviderOptionMap;
}

/** Matches Paseo client `readToggleOption`: explicit boolean wins over control default (false). */
export function readToggleOption(
  control: HubAgentOptionToggleControl,
  options: ProviderOptionMap,
): boolean {
  const value = options[control.key];
  return typeof value === "boolean" ? value : (control.defaultValue ?? false);
}

/** Matches Paseo client `readSelectOption`: valid choice value wins over control default. */
export function readSelectOption(
  control: HubAgentOptionSelectControl,
  options: ProviderOptionMap,
): string | null {
  const value = options[control.key];
  if (typeof value === "string" && control.choices.some((choice) => choice.value === value)) {
    return value;
  }
  return control.defaultValue ?? null;
}

/** Whether a control's effective value differs from its advertised default. */
export function isControlActive(
  control: HubAgentOptionControl,
  options: ProviderOptionMap,
): boolean {
  if (control.type === "toggle") {
    return readToggleOption(control, options) !== (control.defaultValue ?? false);
  }
  const value = readSelectOption(control, options);
  return value !== null && value !== control.defaultValue;
}

/** Active non-default provider options formatted for the collapsed Step 3 Advanced summary. */
export function describeActiveProviderOptions(
  controls: readonly HubAgentOptionControl[],
  options: ProviderOptionMap,
): string[] {
  const parts: string[] = [];
  for (const control of controls) {
    if (!isControlActive(control, options)) continue;
    if (control.type === "toggle") {
      parts.push(readToggleOption(control, options) ? control.label : `${control.label}: Off`);
      continue;
    }
    const selected = readSelectOption(control, options);
    const choice = control.choices.find((candidate) => candidate.value === selected);
    if (choice !== undefined) parts.push(`${control.label}: ${choice.label}`);
  }
  return parts;
}

/** Parses form JSON into a plain JSON-value map when valid, or `undefined` when blank or invalid. */
export function parseFormProviderOptions(raw: string): ProviderOptionMap | undefined {
  if (raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const validated = JsonValueSchema.safeParse(parsed);
  if (
    !validated.success ||
    typeof validated.data !== "object" ||
    validated.data === null ||
    Array.isArray(validated.data)
  ) {
    return undefined;
  }
  return validated.data;
}

/** Sets one top-level provider option key in form JSON while preserving every other key. */
export function updateFormProviderOption(raw: string, key: string, value: WireJsonValue): string {
  const current = parseFormProviderOptions(raw) ?? {};
  return JSON.stringify({ ...current, [key]: value }, null, 2);
}

/** Whether form JSON currently sets at least one key previously drawn as a daemon control. */
export function hasDrawnProviderOptions(raw: string, drawnKeys: ReadonlySet<string>): boolean {
  if (drawnKeys.size === 0) return false;
  const current = parseFormProviderOptions(raw);
  if (current === undefined) return false;
  return Object.keys(current).some((key) => drawnKeys.has(key));
}

/**
 * Drops keys previously drawn as controls when the new model no longer exposes them, and drops
 * select choices the new model no longer offers. Unmodeled options (such as `sandbox_mode`) are
 * never touched, and an initial open with no previously drawn controls leaves the document intact.
 */
export function pruneLostProviderOptions(input: {
  raw: string;
  drawnKeys: ReadonlySet<string>;
  controls: readonly HubAgentOptionControl[];
}): string {
  if (input.drawnKeys.size === 0) return input.raw;
  const current = parseFormProviderOptions(input.raw);
  if (current === undefined) return input.raw;
  const byKey = new Map(input.controls.map((control) => [control.key, control]));
  let changed = false;
  const next: ProviderOptionMap = {};
  for (const [key, value] of Object.entries(current)) {
    if (!input.drawnKeys.has(key)) {
      next[key] = value;
      continue;
    }
    const control = byKey.get(key);
    if (control === undefined) {
      changed = true;
      continue;
    }
    if (
      control.type === "select" &&
      typeof value === "string" &&
      !control.choices.some((choice) => choice.value === value)
    ) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  if (!changed) return input.raw;
  return Object.keys(next).length === 0 ? "" : JSON.stringify(next, null, 2);
}

const NO_CONTROLS: readonly HubAgentOptionControl[] = [];
const NO_OPTIONS: ProviderOptionMap = {};

/**
 * Keeps the current scope's controls mounted while an option edit round-trips to the daemon,
 * overlaying the form's latest values immediately. Switching provider, model, mode, or thinking
 * hides stale controls until the new scope answers.
 */
export function effectiveProviderOptions(input: {
  resolved: ResolvedProviderControls | undefined;
  currentScopeKey: string;
  currentRequestKey: string;
  currentOptions: ProviderOptionMap | undefined;
}): { controls: readonly HubAgentOptionControl[]; options: ProviderOptionMap } {
  const { resolved } = input;
  if (resolved === undefined || resolved.scopeKey !== input.currentScopeKey) {
    return { controls: NO_CONTROLS, options: NO_OPTIONS };
  }
  if (resolved.requestKey === input.currentRequestKey) {
    return { controls: resolved.controls, options: resolved.options };
  }
  const overlaid: ProviderOptionMap = { ...resolved.options };
  const current = input.currentOptions ?? NO_OPTIONS;
  for (const key of Object.keys(resolved.requestedOptions)) {
    if (!(key in current)) delete overlaid[key];
  }
  return {
    controls: resolved.controls,
    options: { ...overlaid, ...current },
  };
}

/**
 * Daemon-exposed provider option controls rendered inside Step 3's Advanced section. Renders
 * nothing when the selected daemon + provider + model exposes no controls.
 */
export function ProviderOptionControls({
  controls,
  options,
  disabled = false,
  onSetOption,
}: {
  controls: readonly HubAgentOptionControl[];
  options: ProviderOptionMap;
  disabled?: boolean;
  onSetOption: (key: string, value: WireJsonValue) => void;
}) {
  if (controls.length === 0) return null;
  const groups = groupControls(controls);
  return (
    <div className="grid gap-4">
      {groups.map((group, index) =>
        group.kind === "selects" ? (
          <div key={`selects-${String(index)}`} className="grid gap-4 sm:grid-cols-2">
            {group.controls.map((control) => (
              <SelectOptionField
                key={control.key}
                control={control}
                options={options}
                disabled={disabled}
                onSetOption={onSetOption}
              />
            ))}
          </div>
        ) : (
          <CheckboxField
            key={group.control.key}
            id={`trigger-provider-option-${group.control.key}`}
            label={group.control.label}
            {...(group.control.description === undefined
              ? {}
              : { description: group.control.description })}
            checked={readToggleOption(group.control, options)}
            disabled={disabled}
            onChange={(checked) => onSetOption(group.control.key, checked)}
          />
        ),
      )}
    </div>
  );
}

function SelectOptionField({
  control,
  options,
  disabled,
  onSetOption,
}: {
  control: HubAgentOptionSelectControl;
  options: ProviderOptionMap;
  disabled: boolean;
  onSetOption: (key: string, value: WireJsonValue) => void;
}) {
  const choices: ComboboxOption[] = control.choices.map((choice) => ({
    value: choice.value,
    label: choice.label,
    ...(choice.description === undefined ? {} : { detail: choice.description }),
  }));
  const value = readSelectOption(control, options) ?? "";
  return (
    <FormField
      id={`trigger-provider-option-${control.key}`}
      label={control.label}
      {...(control.description === undefined ? {} : { description: control.description })}
    >
      {(field) => (
        <Combobox
          {...field}
          value={value}
          options={choices}
          placeholder={`Select ${control.label.toLowerCase()}`}
          empty="No options found"
          disabled={disabled}
          onChange={(option) => onSetOption(control.key, option.value)}
        />
      )}
    </FormField>
  );
}

type ControlGroup =
  | { kind: "selects"; controls: HubAgentOptionSelectControl[] }
  | { kind: "toggle"; control: HubAgentOptionToggleControl };

/** Groups adjacent select controls into 2-column rows while preserving exact daemon order. */
function groupControls(controls: readonly HubAgentOptionControl[]): ControlGroup[] {
  const groups: ControlGroup[] = [];
  for (const control of controls) {
    if (control.type === "toggle") {
      groups.push({ kind: "toggle", control });
      continue;
    }
    const previous = groups[groups.length - 1];
    if (previous?.kind === "selects") previous.controls.push(control);
    else groups.push({ kind: "selects", controls: [control] });
  }
  return groups;
}
