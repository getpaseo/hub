/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- each item's select handler is scoped to the option rendered beside it */
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useCallback, useId, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../ui/command.js";
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
  /** What to say when the search matches nothing, e.g. "No repositories found." */
  empty: string;
  /**
   * The rest of a `FormField`'s wiring, so a labelled combobox is `{...control}` like every
   * other control rather than an id threaded through by hand.
   */
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const choose = useCallback(
    (option: T) => {
      onChange(option);
      setOpen(false);
    },
    [onChange],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
              "truncate",
              comboboxSelection(options, value) === undefined &&
                value === "" &&
                "text-extra-muted-foreground",
            )}
          >
            {comboboxLabel(options, value, placeholder, loading)}
          </span>
          {loading ? (
            <Spinner className="opacity-50" />
          ) : (
            <ChevronsUpDownIcon aria-hidden="true" className="size-4 shrink-0 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popper-anchor-width) p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder ?? `${placeholder}…`} />
          <CommandList id={listId}>
            {loading ? (
              <div className="flex justify-center py-6">
                <LoadingLine>Loading…</LoadingLine>
              </div>
            ) : (
              <>
                <CommandEmpty>{empty}</CommandEmpty>
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    // cmdk keys its search on `value`, and an empty string makes it fall back to
                    // the rendered text. Naming the label keeps an explicit "no choice" option
                    // searchable while the real value still travels back through `onChange`.
                    value={option.value === "" ? option.label : option.value}
                    {...(option.keywords === undefined ? {} : { keywords: [...option.keywords] })}
                    {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
                    data-value={option.value}
                    onSelect={() => choose(option)}
                  >
                    <CheckIcon
                      aria-hidden="true"
                      className={cn(option.value === value ? "opacity-100" : "opacity-0")}
                    />
                    {renderOption === undefined ? (
                      <span className="grid min-w-0 gap-0.5">
                        <span className="truncate">{option.label}</span>
                        {option.detail === undefined ? null : (
                          <span className="truncate text-xs text-muted-foreground">
                            {option.detail}
                          </span>
                        )}
                      </span>
                    ) : (
                      renderOption(option)
                    )}
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

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
 * "Gone away" is a claim about the options, so it waits for them. While they are still arriving
 * the stored value is shown as it is — a value that has not been looked up yet is not a value
 * that was withdrawn.
 */
export function comboboxLabel(
  options: readonly ComboboxOption[],
  value: string,
  placeholder: string,
  loading = false,
): string {
  const selected = comboboxSelection(options, value);
  if (selected !== undefined) return selected.label;
  if (value === "") return placeholder;
  return loading ? value : `${value} (unavailable)`;
}
