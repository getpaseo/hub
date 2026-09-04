import type { FormEvent, ReactNode } from "react";

import { Button } from "../ui/button.js";
import { FieldSet } from "../ui/field.js";

/**
 * A pre-auth form: fields, one submit, and at most one way back. The fieldset is what carries
 * `busy` — disabling the set disables every control inside it at once, so a form in flight
 * cannot be resubmitted and no screen has to thread `disabled` through its own fields.
 *
 * The buttons are the width of the card and stacked, not a right-aligned row. A pre-auth card
 * is one column of one decision, so the thing to press is the width of the thing above it and
 * the way back sits under it — a dashboard form is the one with a row of actions.
 */
export function AuthForm({
  label,
  busy,
  submitLabel,
  onSubmit,
  secondaryLabel,
  onSecondary,
  children,
}: {
  label: string;
  busy: boolean;
  submitLabel: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /**
   * The way out of this form, e.g. "Back to sign in". Two flat props rather than one object:
   * an object literal is a new value on every render, so every caller had to memoize one.
   */
  secondaryLabel?: string;
  onSecondary?: () => void;
  children: ReactNode;
}) {
  return (
    <form method="post" aria-label={label} aria-busy={busy} onSubmit={onSubmit}>
      <FieldSet disabled={busy}>
        {children}
        <div className="grid gap-2">
          <Button type="submit" size="lg" className="w-full">
            {submitLabel}
          </Button>
          {secondaryLabel === undefined || onSecondary === undefined ? null : (
            <Button
              type="button"
              size="lg"
              variant="outline"
              className="w-full"
              onClick={onSecondary}
            >
              {secondaryLabel}
            </Button>
          )}
        </div>
      </FieldSet>
    </form>
  );
}
