import { useMemo, type ReactNode } from "react";

import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { Textarea } from "../ui/textarea.js";

/**
 * What kind of value the operator is typing, not which element renders it. `secret` is a
 * provider credential: write-only, so the server never returns it and the input arrives empty
 * rather than prefilled with a mask that could be submitted back as if it were the real value.
 */
export type FormFieldKind = "text" | "email" | "password" | "secret" | "multiline";

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
   * Explicit, never defaulted. "Everything is required unless it says otherwise" is a rule the
   * form knows and the field cannot, and a field that guesses puts a red mark on optional
   * values and browser validation in front of a submit that would have succeeded.
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
  minLength?: number;
}

/**
 * The one way to label a control. The field owns the wiring — `htmlFor`, `aria-describedby`
 * for both the description and the error, `aria-invalid`, the required mark — so no screen
 * has to remember it and no two screens can remember it differently.
 *
 * A plain input is the common case, so name its `kind` and the field renders it. Anything else
 * — a select, a combobox, a checkbox, an editor — is a function that receives the attributes
 * the control must carry:
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
      <FieldLabel htmlFor={id}>
        {label}
        {required === true ? (
          <span aria-hidden="true" className="text-extra-muted-foreground">
            *
          </span>
        ) : null}
      </FieldLabel>
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
};

function TypedInput({
  kind,
  name,
  defaultValue,
  value,
  readOnly,
  disabled,
  autoComplete,
  minLength,
  control,
}: TypedControl & { control: FieldControl }) {
  const shared = {
    ...control,
    name,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(value === undefined ? {} : { value }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(disabled === undefined ? {} : { disabled }),
    ...(minLength === undefined ? {} : { minLength }),
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
      {...shared}
    />
  );
}
