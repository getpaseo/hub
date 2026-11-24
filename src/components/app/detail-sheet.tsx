/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- the sheet maps its own open-change to the caller's close */
import { ChevronDown, ChevronUp, XIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { Button } from "../ui/button.js";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet.js";
import { Skeleton } from "../ui/skeleton.js";
import { StatusPill, type StatusTone } from "./status-pill.js";

/**
 * One record of a list, opened beside it. The list stays where the reader left it, so the
 * sheet is for reading a record and acting on it, never for a task that needs its own page.
 *
 * The record is the caller's to fetch; the sheet owns the frame: the title and state on one line,
 * the record's actions under them, a body that scrolls on its own, and stepping to the
 * neighbouring records with the arrows or `j` and `k` without going back to the list.
 */
export function DetailSheet({
  open,
  onClose,
  title,
  description,
  status,
  actions,
  onPrevious,
  onNext,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Absent while the record loads: the header holds its place with a placeholder. */
  title: string | undefined;
  description?: string;
  status?: { label: string; tone: StatusTone };
  /** The record's buttons and links, e.g. "Open in Paseo". */
  actions?: ReactNode;
  /** Step to the record above this one in the list; absent at the top. */
  onPrevious?: () => void;
  /** Step to the record below; absent at the bottom of the page. */
  onNext?: () => void;
  children: ReactNode;
}) {
  useRecordKeys(open, onPrevious, onNext);
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        side="right"
        // The sheet is wide enough for an indented payload; the list beside it stays readable
        // from `lg`, and below that the sheet is the screen.
        className="w-full gap-0 sm:max-w-xl"
        // The close button joins the steppers in the header row instead of floating in the
        // corner, so all three share one size, one line, and one right edge.
        showCloseButton={false}
        // The sheet takes focus itself, so `j`, `k`, and Escape work at once without lighting a
        // ring on whichever button happens to come first — usually Previous record.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
        }}
        {...(description === undefined ? { "aria-describedby": undefined } : {})}
      >
        <SheetHeader className="gap-3 border-b px-6 pt-5 pb-4">
          <div className="flex min-w-0 items-start gap-4">
            <div className="grid min-w-0 flex-1 gap-1">
              <span className="flex min-w-0 items-center gap-2">
                {title === undefined ? (
                  <>
                    <SheetTitle className="sr-only">Loading</SheetTitle>
                    <Skeleton className="h-6 w-48" />
                  </>
                ) : (
                  <SheetTitle className="truncate">{title}</SheetTitle>
                )}
                {status === undefined ? null : (
                  <StatusPill tone={status.tone}>{status.label}</StatusPill>
                )}
              </span>
              {description === undefined ? null : (
                <SheetDescription className="truncate">{description}</SheetDescription>
              )}
            </div>
            {/* A 28px control against the title's 24px line: -mt-0.5 centres them on it, and
                -mr-1.5 sets the close glyph, not its hit area, on the header's right edge. */}
            <div className="-mt-0.5 -mr-1.5 flex shrink-0 items-center gap-1">
              {onPrevious === undefined && onNext === undefined ? null : (
                <div className="flex items-center">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Previous record"
                    aria-keyshortcuts="k"
                    disabled={onPrevious === undefined}
                    onClick={onPrevious}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Next record"
                    aria-keyshortcuts="j"
                    disabled={onNext === undefined}
                    onClick={onNext}
                  >
                    <ChevronDown />
                  </Button>
                </div>
              )}
              <SheetClose asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Close">
                  <XIcon />
                </Button>
              </SheetClose>
            </div>
          </div>
          {actions === undefined ? null : (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/** `j` and `k` step through the list while the sheet is open, unless the reader is typing. */
function useRecordKeys(
  open: boolean,
  onPrevious: (() => void) | undefined,
  onNext: (() => void) | undefined,
) {
  useEffect(() => {
    if (!open) return undefined;
    const step = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const keys: Readonly<Record<string, (() => void) | undefined>> = {
        j: onNext,
        k: onPrevious,
      };
      const move = keys[event.key];
      if (move === undefined) return;
      event.preventDefault();
      move();
    };
    document.addEventListener("keydown", step);
    return () => document.removeEventListener("keydown", step);
  }, [open, onPrevious, onNext]);
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}
