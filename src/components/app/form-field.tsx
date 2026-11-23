import { useCallback, useMemo, type ChangeEvent, type ReactNode } from "react";

import { Field, FieldDescription, FieldLabel, FieldError } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { Skeleton } from "../ui/skeleton.js";
import { Textarea } from "../ui/textarea.js";

/**
 * What kind of value the operator is typing, not which element renders it. `secret` is a
 * provider credential: write-only, so the server never returns it and the input arrives empty
 * rather than prefilled with a mask that could be submitted back as if it were the real value.
 */
export type FormFieldKind = "text" | "email" | "password" | "secret" | "multiline" | "number";

/** The attributes a control needs to be part of its field. Never assembled by a caller. */
export interface FieldControl {
  id: string;
  required?: boolean;
  "aria-invalid": boolean;
  "aria-describedby"?: string;
}

interface Frame {
  id: string;
  label: string;
  description?: string;
  error?: string;
  /**
   * Validation semantics only — it reaches the control, and nothing is drawn beside the label.
   * A mark on the label is text as far as an accessible name is concerned, so "New password*"
   * is what a label lookup has to ask for; the form says what is optional in words instead.
   *
   * Explicit, never defaulted. "Everything is required unless it says otherwise" is a rule the
   * form knows and the field cannot, and a field that guesses puts browser validation in front
   * of a submit that would have succeeded.
   */
  required?: boolean;
}

interface TypedControl {
  kind: FormFieldKind;
  name: string;
  defaultValue?: string;
  value?: string;
  readOnly?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  /** A shape the browser refuses before the request is made, e.g. a slug's alphabet. */
  pattern?: string;
  min?: number;
  step?: number;
  inputMode?: "text" | "numeric" | "decimal" | "email" | "url" | "tel" | "search" | "none";
  /**
   * A controlled field hands back the value, not the event. Reaching the event target is the
   * only thing a screen used the render-prop escape hatch for, and doing it here is what keeps
   * a controlled text field the same three lines as an uncontrolled one.
   */
  onChange?: (value: string) => void;
}

/**
 * The one way to label a control. The field owns the wiring — `htmlFor`, `aria-describedby`
 * for both the description and the error, `aria-invalid`, `required` — so no screen has to
 * remember it and no two screens can remember it differently.
 *
 * A plain input is the common case, so name its `kind` and the field renders it. Anything the
 * platform has no input type for — a select, a combobox, a checkbox group, an editor — is a
 * function that receives the attributes the control must carry:
 *
 * ```tsx
 * <FormField id="role" label="Role">{(control) => <SelectTrigger {...control} />}</FormField>
 * ```
 */
export function FormField(
  props: Frame & (TypedControl | { children: (control: FieldControl) => ReactNode }),
) {
  const { id, label, description, error, required } = props;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const control = useMemo<FieldControl>(() => {
    const describedBy = [
      description === undefined ? undefined : descriptionId,
      error === undefined ? undefined : errorId,
    ]
      .filter((value) => value !== undefined)
      .join(" ");
    return {
      id,
      ...(required === undefined ? {} : { required }),
      "aria-invalid": error !== undefined,
      ...(describedBy === "" ? {} : { "aria-describedby": describedBy }),
    };
  }, [description, descriptionId, error, errorId, id, required]);
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {"children" in props ? props.children(control) : <TypedInput {...props} control={control} />}
      {description === undefined ? null : (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      )}
      {error === undefined ? null : <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  );
}

const INPUT_TYPES: Record<Exclude<FormFieldKind, "multiline">, string> = {
  text: "text",
  email: "email",
  password: "password",
  secret: "password",
  number: "number",
};

function TypedInput({
  kind,
  name,
  defaultValue,
  value,
  readOnly,
  disabled,
  autoComplete,
  placeholder,
  minLength,
  maxLength,
  pattern,
  min,
  step,
  inputMode,
  onChange,
  control,
}: TypedControl & { control: FieldControl }) {
  const emit = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange?.(event.target.value),
    [onChange],
  );
  const shared = {
    ...control,
    name,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(value === undefined ? {} : { value }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(disabled === undefined ? {} : { disabled }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(onChange === undefined ? {} : { onChange: emit }),
  };
  if (kind === "multiline") return <Textarea rows={4} spellCheck={false} {...shared} />;
  // Nothing typed into these fields is prose. An identifier, a key, or a workspace name is not
  // a word the browser should learn, offer back, or underline in red. Sign-in fields are the
  // exception and always name their own completion.
  const completion = autoComplete ?? (kind === "email" || kind === "password" ? undefined : "off");
  return (
    <Input
      type={INPUT_TYPES[kind]}
      spellCheck={false}
      {...(completion === undefined ? {} : { autoComplete: completion })}
      {...(pattern === undefined ? {} : { pattern })}
      {...(min === undefined ? {} : { min })}
      {...(step === undefined ? {} : { step })}
      {...(inputMode === undefined ? {} : { inputMode })}
      {...shared}
    />
  );
}

/**
 * A field before its value is known: the label bar, the control, and the line under it, in the
 * box a real field occupies. It mirrors `FormField`, so a form waiting on a read is the same
 * grid it will be, and nothing moves when the values land.
 */
export function FieldSkeleton({ description = true }: { description?: boolean }) {
  return (
    <div className="grid gap-2">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-8 w-full" />
      {description ? <Skeleton className="h-4 w-48" /> : null}
    </div>
  );
}
