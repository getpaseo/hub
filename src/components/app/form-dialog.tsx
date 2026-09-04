import type { FormEvent, ReactNode } from "react";

import { Button } from "../ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";
import { FieldSet } from "../ui/field.js";
import { FormActions } from "./form-actions.js";

/**
 * A dialog whose body is one form with one submit. One width for every such dialog, because a
 * dialog that is wider than its neighbour reads as more important than its neighbour, and none
 * of these are. Dismissal is the dialog's own close control, so the form never grows a Cancel
 * button competing with the thing the reader opened it to do.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  submitLabel,
  busy,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** The form's accessible name, e.g. "Create organization". */
  label: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description === undefined ? null : <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form aria-label={label} aria-busy={busy} onSubmit={onSubmit}>
          <FieldSet disabled={busy}>
            {children}
            <FormActions>
              <Button type="submit">{submitLabel}</Button>
            </FormActions>
          </FieldSet>
        </form>
      </DialogContent>
    </Dialog>
  );
}
