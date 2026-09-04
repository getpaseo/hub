import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "../ui/button.js";
import { Field, FieldDescription, FieldLabel } from "../ui/field.js";

const CONFIRMATION_MS = 2000;

type CopyState = "idle" | "copied" | "manual";

/**
 * Copying a generated URL into a provider's portal is the single most repeated action on the
 * app setup surface, so the value and its copy control are one component. The accessible name
 * of the button never changes — the confirmation is announced in a live region instead, so a
 * screen reader hears "Copied Callback URL" without the button renaming itself under the user.
 */
function useCopy(label: string, value: string) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(() => {
    clearTimeout(timer.current);
    const write = navigator.clipboard?.writeText(value);
    if (write === undefined) {
      setState("manual");
      return;
    }
    // A denied permission or an insecure context is not an error the operator can act on by
    // retrying. Tell them to select the value instead, and leave the value on screen.
    void write
      .then(() => {
        setState("copied");
        timer.current = setTimeout(() => setState("idle"), CONFIRMATION_MS);
        return true;
      })
      .catch(() => setState("manual"));
  }, [value]);
  const announcement = state === "copied" ? `Copied ${label}` : "";
  return { state, copy, announcement };
}

function CopyControl({
  label,
  copied,
  onCopy,
  children,
}: {
  /** The button's accessible name, already worded. */
  label: string;
  copied: boolean;
  onCopy: () => void;
  children?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size={children === undefined ? "icon-sm" : "sm"}
      aria-label={children === undefined ? label : undefined}
      className="shrink-0"
      onClick={onCopy}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {children}
    </Button>
  );
}

/**
 * The confirmation, for whoever is not looking at the button. `role="status"` as well as the
 * live attribute: the role is what a test — and some screen readers — find the region by, and
 * an element that is only `aria-live` has no role to be found under.
 */
function Announcement({ message }: { message: string }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {message}
    </span>
  );
}

/**
 * Copy this value, with nothing else on screen about it. For a value that is already visible in
 * something that is not a field — an editor pane, a preview — where the label and the box a
 * `CopyField` draws would be a second copy of what the reader is already looking at.
 */
export function CopyButton({ label, value }: { label: string; value: string }) {
  const { state, copy, announcement } = useCopy(label, value);
  return (
    <>
      <CopyControl label={`Copy ${label}`} copied={state === "copied"} onCopy={copy} />
      <Announcement message={announcement} />
    </>
  );
}

/**
 * The one code treatment: a fixed-width block that wraps. An unwrapped `pre` is as wide as its
 * longest line, and that width propagates out through the parent's grid tracks until the whole
 * body is wider than the phone and the section clips the parts that no longer fit. `break-all`
 * is what makes a bare URL a wrappable line rather than one long word.
 *
 * Pass `label` when the block is long enough to scroll: it names the region and makes it
 * reachable with the keyboard, which a bare `pre` with an overflow is not.
 */
export function CodeBlock({ label, children }: { label?: string; children: string }) {
  const scrollable =
    label === undefined
      ? {}
      : { role: "textbox", "aria-readonly": true, "aria-label": label, tabIndex: 0 };
  return (
    <pre
      {...scrollable}
      className="max-h-48 overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap [scrollbar-color:var(--input)_transparent] [scrollbar-width:thin] sm:max-h-64"
    >
      {children}
    </pre>
  );
}

/**
 * A value to copy, its label, and the one control that copies it.
 *
 * `focusOnMount` is for a value shown once and never again — a generated secret — where the
 * whole point of the surface is that value: it arrives focused and already selected, so the
 * browser's own copy shortcut works before anything is clicked. Holding a caret and a selection
 * needs a real text control, so that path renders a read-only input; every other value stays a
 * span, which is what lets a long URL wrap inside the box instead of scrolling out of a narrow
 * column. The box, the type, and the button are the same either way.
 */
export function CopyField({
  label,
  value,
  copyLabel,
  focusOnMount = false,
}: {
  label: string;
  value: string;
  /** The copy button's accessible name, when "Copy <label>" is not what it should say. */
  copyLabel?: string;
  focusOnMount?: boolean;
}) {
  const { state, copy, announcement } = useCopy(label, value);
  const id = useId();
  const text = useRef<HTMLSpanElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusOnMount) return;
    field.current?.focus();
    field.current?.select();
  }, [focusOnMount]);
  // The manual path has to leave the operator something to do: put the whole value in their
  // selection so the browser's own copy shortcut finishes the job.
  const select = useCallback(() => {
    if (field.current !== null) {
      field.current.select();
      return;
    }
    const node = text.current;
    if (node === null) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);
  const onCopy = useCallback(() => {
    copy();
    select();
  }, [copy, select]);
  return (
    <Field className="min-w-0 gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {/*
        The box is the control, so the box carries the ring: the input inside it is borderless
        and drawing a 2px-offset outline around it would land the ring inside the border it is
        meant to be announcing. The copy button keeps its own ring, which is why this asks for a
        focused input rather than for focus anywhere within.
      */}
      <div className="flex min-h-8 items-center gap-1 rounded-md border border-input bg-transparent py-1 pr-1 pl-2.5 has-[input:focus-visible]:outline-1 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring">
        {focusOnMount ? (
          <input
            ref={field}
            id={id}
            readOnly
            value={value}
            onFocus={selectOnFocus}
            className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
          />
        ) : (
          <span ref={text} id={id} className="min-w-0 flex-1 font-mono text-xs break-all">
            {value}
          </span>
        )}
        <CopyControl
          label={copyLabel ?? `Copy ${label}`}
          copied={state === "copied"}
          onCopy={onCopy}
        />
      </div>
      {state === "manual" ? (
        <FieldDescription>Select the value and copy it.</FieldDescription>
      ) : null}
      <Announcement message={announcement} />
    </Field>
  );
}

function selectOnFocus(event: { currentTarget: HTMLInputElement }): void {
  event.currentTarget.select();
}

export function CopyBlock({
  label,
  value,
  action,
}: {
  label: string;
  value: string;
  /** The visible button text, e.g. "Copy manifest". */
  action: string;
}) {
  const { state, copy, announcement } = useCopy(label, value);
  return (
    <Field className="min-w-0 gap-2">
      <div className="flex items-center justify-between gap-2">
        <FieldLabel>{label}</FieldLabel>
        <CopyControl label={`Copy ${label}`} copied={state === "copied"} onCopy={copy}>
          {action}
        </CopyControl>
      </div>
      <CodeBlock label={`${label} value`}>{value}</CodeBlock>
      {state === "manual" ? (
        <FieldDescription>Select the value and copy it.</FieldDescription>
      ) : null}
      <Announcement message={announcement} />
    </Field>
  );
}
