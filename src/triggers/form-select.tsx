import { useCallback } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";

const EMPTY_VALUE = "__paseo_empty_select_value__";

export interface TriggerSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function TriggerSelect({
  id,
  value,
  options,
  placeholder,
  required,
  onChange,
}: {
  id: string;
  value: string;
  options: TriggerSelectOption[];
  placeholder?: string;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  const hasEmptyOption = options.some((option) => option.value === "");
  const change = useCallback(
    (nextValue: string) => onChange(nextValue === EMPTY_VALUE ? "" : nextValue),
    [onChange],
  );
  const selectedValue = value === "" && hasEmptyOption ? EMPTY_VALUE : value;
  return (
    <Select value={selectedValue} onValueChange={change}>
      <SelectTrigger id={id} className="w-full" aria-required={required} data-value={value}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value === "" ? EMPTY_VALUE : option.value}
            {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
            data-value={option.value}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
