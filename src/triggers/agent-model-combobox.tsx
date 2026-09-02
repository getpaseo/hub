import { useCallback, useId, useState } from "react";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { Button } from "../components/ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import { cn } from "../lib/utils.js";

export interface AgentModelOption {
  value: string;
  label: string;
  providerLabel: string;
  keywords: string[];
}

export function AgentModelCombobox({
  options,
  value,
  onSelect,
}: {
  options: AgentModelOption[];
  value: string;
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  const selectedLabel =
    selected?.label ?? (value === "" ? "Select a model" : `${value} (unavailable)`);
  const choose = useCallback(
    (nextValue: string) => {
      onSelect(nextValue);
      setOpen(false);
    },
    [onSelect],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id="trigger-agent"
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-required="true"
          data-value={value}
          className="w-full min-w-0 justify-between font-normal"
        >
          <span className="truncate">{selectedLabel}</span>
          <ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popper-anchor-width) p-0" align="start">
        <Command>
          <CommandInput placeholder="Search models…" />
          <CommandList id={listId}>
            <CommandEmpty>No models found.</CommandEmpty>
            {options.map((option) => (
              <AgentModelCommandItem
                key={option.value}
                option={option}
                selected={option.value === value}
                onSelect={choose}
              />
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AgentModelCommandItem({
  option,
  selected,
  onSelect,
}: {
  option: AgentModelOption;
  selected: boolean;
  onSelect: (value: string) => void;
}) {
  const choose = useCallback(() => onSelect(option.value), [onSelect, option.value]);
  return (
    <CommandItem value={option.value} keywords={option.keywords} onSelect={choose}>
      <CheckIcon className={cn(selected ? "opacity-100" : "opacity-0")} />
      <span className="min-w-0">
        <span className="block truncate">{option.label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {option.providerLabel} · {option.value}
        </span>
      </span>
    </CommandItem>
  );
}
