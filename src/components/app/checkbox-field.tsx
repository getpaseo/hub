import { useCallback, type ChangeEvent } from "react";

import { CheckboxInput } from "../ui/checkbox.js";

/**
 * A checkbox, the thing it turns on, and what that costs — box first, label beside it.
 *
 * A checkbox is the one control whose label does not go above it. Stacked in a `FormField` the
 * box ends up alone on a line under a heading, reading as a field whose value went missing; the
 * label has to be the thing you can click, and it has to sit next to the box you are clicking.
 * The description wraps under the label rather than truncating: a box nobody can read in full is
 * a box ticked blind.
 */
export function CheckboxField({
  id,
  label,
  description,
  name,
  value,
  checked,
  defaultChecked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  name?: string;
  /** The value submitted for this box when several share one `name`. */
  value?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  const emit = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange?.(event.target.checked),
    [onChange],
  );
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
      <CheckboxInput
        id={id}
        {...(name === undefined ? {} : { name })}
        {...(value === undefined ? {} : { value })}
        {...(checked === undefined ? {} : { checked })}
        {...(defaultChecked === undefined ? {} : { defaultChecked })}
        {...(disabled === undefined ? {} : { disabled })}
        {...(onChange === undefined ? {} : { onChange: emit })}
      />
      <span className="grid gap-0.5">
        <span>{label}</span>
        {description === undefined ? null : (
          <span className="text-xs text-muted-foreground">{description}</span>
        )}
      </span>
    </label>
  );
}
