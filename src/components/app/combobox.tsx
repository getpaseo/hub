/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- each item's select handler is scoped to the option rendered beside it */
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  defaultFilter,
} from "../ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import { LoadingLine, Spinner } from "./loading.js";

export interface ComboboxOption {
  /** The stored value. May be empty for an explicit "no choice" option. */
  value: string;
  label: string;
  /** Extra words the search should match, e.g. a provider name or an alias. */
  keywords?: readonly string[];
  /** The quiet second line under the label. */
  detail?: string;
  /**
   * An opaque ID, shown as the second line when there is no `detail`. Typing part of it finds the
   * option, but only as a run of consecutive characters: the search's usual leniency, letters in
   * order however far apart, would match nearly every option through the scattered characters of
   * a random ID.
   */
  identifier?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

/**
 * Pick one of many, with search. The one dropdown on the dashboard: a model, a repository, an
 * event type. It hands back the whole option rather than its value, so a caller that needs the
 * record behind the choice does not have to look it up again.
 *
 * A value that is no longer among the options is shown, marked unavailable, rather than
 * silently reading as empty — a trigger pointing at a model the daemon stopped offering must
 * say so instead of looking unset.
 */
export function Combobox<T extends ComboboxOption>({
  id,
  label,
  value,
  options,
  onChange,
  placeholder,
  searchPlaceholder,
  loading = false,
  required = false,
  disabled = false,
  renderOption,
  empty,
  custom,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: {
  id: string;
  /** The accessible name, when no `FormField` label points at this control. */
  label?: string;
  value: string;
  options: readonly T[];
  onChange: (option: T) => void;
  /** What the closed trigger says when nothing is chosen, e.g. "Select a model". */
  placeholder: string;
  /**
   * What the search box says. Defaults to the trigger's own placeholder with an ellipsis, which
   * is right when the trigger names the thing; name it separately when the search is doing
   * something the trigger's words do not describe, e.g. "Search models…".
   */
  searchPlaceholder?: string;
  /** The options are still arriving. The list says so rather than saying there are none. */
  loading?: boolean;
  required?: boolean;
  disabled?: boolean;
  /** Replaces the default label-over-detail line inside an option. */
  renderOption?: (option: T) => ReactNode;
  /** What to say when the search matches nothing, e.g. "No repositories found" */
  empty: string;
  /**
   * Lets the reader use a value the options do not list, such as a path nobody suggested. Given
   * what they typed, it returns the option to offer for it, or `undefined` while the text is not
   * a usable value. A stored value outside the options is then the reader's own and is shown as
   * it is, never as one that went away.
   */
  custom?: (typed: string) => T | undefined;
  /**
   * The rest of a `FormField`'s wiring, so a labelled combobox is `{...control}` like every
   * other control rather than an id threaded through by hand.
   */
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlighted, setHighlighted] = useState("");
  const listId = useId();
  const listed = useMemo(
    () => withCustomOption(options, custom?.(value)),
    [options, custom, value],
  );
  const typed = unlistedOption(listed, custom?.(search.trim()));
  const typedValue = typed === undefined ? undefined : itemValue(typed);
  const filter = useMemo(() => comboboxFilter(listed, typedValue), [listed, typedValue]);
  // A search belongs to one opening of the list: the next one starts from every option.
  const toggle = useCallback((next: boolean) => {
    setOpen(next);
    setSearch("");
    setHighlighted("");
  }, []);
  const handleSearch = useCallback(
    (next: string) => {
      setSearch(next);
      const nextTyped = unlistedOption(listed, custom?.(next.trim()));
      if (nextTyped !== undefined) setHighlighted(itemValue(nextTyped));
    },
    [listed, custom],
  );
  const choose = useCallback(
    (option: T) => {
      onChange(option);
      toggle(false);
    },
    [onChange, toggle],
  );
  const selected = comboboxSelection(listed, value);

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          {...(label === undefined ? {} : { "aria-label": label })}
          {...(required ? { "aria-required": true } : {})}
          {...(invalid === undefined ? {} : { "aria-invalid": invalid })}
          {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
          disabled={disabled}
          data-value={value}
          className="w-full min-w-0 justify-between"
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-2",
              selected === undefined && value === "" && "text-extra-muted-foreground",
            )}
          >
            {selected?.icon}
            <span className="truncate">
              {comboboxLabel(listed, value, placeholder, loading || custom !== undefined)}
            </span>
          </span>
          {loading ? (
            <Spinner className="opacity-50" />
          ) : (
            <ChevronsUpDownIcon aria-hidden="true" className="size-4 shrink-0 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popper-anchor-width) p-0" align="start">
        <Command filter={filter} value={highlighted} onValueChange={setHighlighted}>
          <CommandInput
            placeholder={searchPlaceholder ?? `${placeholder}…`}
            value={search}
            onValueChange={handleSearch}
          />
          <CommandList id={listId}>
            <ComboboxOptions
              loading={loading}
              empty={empty}
              value={value}
              listed={listed}
              typed={typed}
              onChoose={choose}
              {...(renderOption === undefined ? {} : { renderOption })}
            />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ComboboxOptions<T extends ComboboxOption>({
  loading,
  empty,
  value,
  listed,
  typed,
  onChoose,
  renderOption,
}: {
  loading: boolean;
  empty: string;
  value: string;
  listed: readonly T[];
  typed: T | undefined;
  onChoose: (option: T) => void;
  renderOption?: (option: T) => ReactNode;
}) {
  return (
    <>
      {typed === undefined ? null : (
        // The reader's own text stays first and active for Enter once valid, even while
        // suggestions load or partially match what they typed.
        <CommandItem
          key={typed.value}
          value={itemValue(typed)}
          data-value={typed.value}
          onSelect={() => onChoose(typed)}
        >
          <OptionLine option={typed} chosen={false}>
            {renderOption?.(typed)}
          </OptionLine>
        </CommandItem>
      )}
      {loading ? null : (
        <>
          {typed === undefined ? <CommandEmpty>{empty}</CommandEmpty> : null}
          {listed.map((option) => (
            <CommandItem
              key={option.value}
              // cmdk keys its search on `value`, and an empty string makes it fall back to
              // the rendered text. Naming the label keeps an explicit "no choice" option
              // searchable while the real value still travels back through `onChange`.
              value={itemValue(option)}
              {...(option.keywords === undefined ? {} : { keywords: [...option.keywords] })}
              {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
              data-value={option.value}
              onSelect={() => onChoose(option)}
            >
              <OptionLine option={option} chosen={option.value === value}>
                {renderOption?.(option)}
              </OptionLine>
            </CommandItem>
          ))}
        </>
      )}
      {loading ? (
        <div className={cn("flex justify-center", typed === undefined ? "py-6" : "py-3")}>
          <LoadingLine>Loading…</LoadingLine>
        </div>
      ) : null}
    </>
  );
}

/** One option inside the list: the mark for the current choice, the icon, then the two lines. */
function OptionLine({
  option,
  chosen,
  children,
}: {
  option: ComboboxOption;
  chosen: boolean;
  /** What a caller's `renderOption` drew, in place of the default label over detail. */
  children: ReactNode;
}) {
  return (
    <>
      <CheckIcon aria-hidden="true" className={cn(chosen ? "opacity-100" : "opacity-0")} />
      {option.icon}
      {children ?? (
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate">{option.label}</span>
          {(option.detail ?? option.identifier) === undefined ? null : (
            <span className="truncate text-xs text-muted-foreground">
              {option.detail ?? option.identifier}
            </span>
          )}
        </span>
      )}
    </>
  );
}

/** A custom option, unless the options already list its value. */
function unlistedOption<T extends ComboboxOption>(
  options: readonly T[],
  option: T | undefined,
): T | undefined {
  if (option === undefined) return undefined;
  return options.some(({ value }) => value === option.value) ? undefined : option;
}

/**
 * The options plus the reader's own stored value, so a path nobody suggested is still in the list
 * with the mark beside it.
 */
export function withCustomOption<T extends ComboboxOption>(
  options: readonly T[],
  custom: T | undefined,
): readonly T[] {
  const own = unlistedOption(options, custom);
  return own === undefined ? options : [...options, own];
}

/** The value cmdk keys an option by. An empty stored value is keyed by its label. */
function itemValue(option: ComboboxOption): string {
  // cmdk falls back to the rendered text for an empty value. Naming the label keeps an explicit
  // "no choice" option searchable while the real value still travels back through `onChange`.
  return option.value === "" ? option.label : option.value;
}

/**
 * How a search scores each option: cmdk's own scoring, so shorthand like "pr" or "ny" keeps
 * working. An option with an `identifier` is scored on its label and keywords alone, never on its
 * stored value, which can embed the ID; a consecutive-characters match on the identifier or the
 * stored value (a pasted slug) only keeps the option in the list, below every named match.
 */
export function comboboxFilter(
  options: readonly ComboboxOption[],
  typedValue?: string,
): (value: string, search: string, keywords?: string[]) => number {
  const byIdentifier = new Map<string, ComboboxOption & { identifier: string }>();
  for (const option of options) {
    if (option.identifier !== undefined) {
      byIdentifier.set(itemValue(option), { ...option, identifier: option.identifier });
    }
  }
  return (value, search, keywords) => {
    if (typedValue !== undefined && value === typedValue) return CUSTOM_TYPED_SCORE;
    const option = byIdentifier.get(value);
    if (option === undefined) return defaultFilter(value, search, keywords);
    const score = defaultFilter(option.label, search, keywords);
    const typed = search.trim().toLowerCase();
    const runs = [option.identifier, value].some((text) => text.toLowerCase().includes(typed));
    if (score > 0 || typed === "" || !runs) return score;
    return IDENTIFIER_ONLY_SCORE;
  };
}

/** Strictly above cmdk's [0, 1] match scores so an exact typed custom value stays first on Enter. */
const CUSTOM_TYPED_SCORE = 2;

/** Below any score cmdk gives a word match, so an ID-only hit never outranks a named one. */
const IDENTIFIER_ONLY_SCORE = 1e-6;

/** The option a stored value refers to, or `undefined` when it refers to nothing on offer. */
export function comboboxSelection<T extends ComboboxOption>(
  options: readonly T[],
  value: string,
): T | undefined {
  return options.find((option) => option.value === value);
}

/**
 * What the closed trigger reads: the choice, the placeholder, or a value that has gone away.
 *
 * "Gone away" is a claim about the options, so it is made only when they are the whole answer.
 * While they are still arriving, or when the reader may enter a value of their own, the stored
 * value is shown as it is — a value that was never looked up, or never had to be on the list, is
 * not a value that was withdrawn.
 */
export function comboboxLabel(
  options: readonly ComboboxOption[],
  value: string,
  placeholder: string,
  open = false,
): string {
  const selected = comboboxSelection(options, value);
  if (selected !== undefined) return selected.label;
  if (value === "") return placeholder;
  return open ? value : `${value} (unavailable)`;
}
