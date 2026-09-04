import type { FormEvent, ReactNode } from "react";

import { Button } from "../ui/button.js";
import { FieldSet } from "../ui/field.js";
import { FormActions } from "./form-actions.js";

/**
 * A pre-auth form: fields, one submit, and at most one way back. The fieldset is what carries
 * `busy` — disabling the set disables every control inside it at once, so a form in flight
 * cannot be resubmitted and no screen has to thread `disabled` through its own fields.
 *
 * The secondary action lives in the same row as submit rather than wherever the screen had
 * room. "Back", "Sign out", and "Use a different account" are all the same offer.
 */
export function AuthForm({
  label,
  busy,
  submitLabel,
  onSubmit,
  secondary,
  children,
}: {
  label: string;
  busy: boolean;
  submitLabel: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** The way out of this form, e.g. "Back to sign in". */
  secondary?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <form method="post" aria-label={label} aria-busy={busy} onSubmit={onSubmit}>
      <FieldSet disabled={busy}>
        {children}
        <FormActions>
          {secondary === undefined ? null : (
            <Button type="button" variant="ghost" onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          )}
          <Button type="submit">{submitLabel}</Button>
        </FormActions>
      </FieldSet>
    </form>
  );
}
