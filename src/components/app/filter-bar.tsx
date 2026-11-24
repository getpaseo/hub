/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- each control's handlers are scoped to the control rendered beside them */
import { SearchIcon, XIcon } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";

/**
 * The controls that narrow a list, in one wrapping row above it. Filters are one row because
 * they are one decision the reader is making about one list; on a phone the row wraps rather
 * than scrolling, so no filter is out of sight.
 */
export function FilterBar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      {children}
    </div>
  );
}

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * One filter: its name, then the value it is set to, on the trigger itself, so the reader sees
 * what the list is narrowed by without opening anything. The name is quiet and the value is
 * the fact, which is how a filter left at "All" reads as untouched.
 */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly FilterOption[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="max-w-64">
        <span className="text-muted-foreground">{label}</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Text search over a list. It applies when the reader presses Enter, not on every keystroke: a
 * list that reloads under each letter loses the row the reader was looking at, and the URL it
 * writes would record every half-typed word.
 */
export function FilterSearch({
  label,
  placeholder,
  value,
  onSearch,
}: {
  label: string;
  placeholder: string;
  /** The search the list is filtered by now. */
  value: string;
  onSearch: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // The applied search changes from outside too: Clear filters, the back button, a pasted link.
  const [applied, setApplied] = useState(value);
  if (applied !== value) {
    setApplied(value);
    setDraft(value);
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(draft.trim());
  };
  return (
    <form role="search" onSubmit={submit} className="relative w-full sm:w-64">
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="pr-8 pl-8 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {draft === "" ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Clear search"
          className="absolute top-1/2 right-1 -translate-y-1/2"
          onClick={() => {
            setDraft("");
            onSearch("");
          }}
        >
          <XIcon />
        </Button>
      )}
    </form>
  );
}
