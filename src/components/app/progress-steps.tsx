import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

export type ProgressStepState = "done" | "todo" | "blocked";

export interface ProgressStep {
  key: string;
  title: string;
  /** `blocked`: started, but stuck on something the reader has to fix. */
  state: ProgressStepState;
  /** What a done step produced, on the same line as its title. */
  result?: ReactNode;
  /** One clause on what to do. Shown only while the step is the open one. */
  hint?: ReactNode;
  /** The open step's one control: a button, or a `CopyField` with the command to run. */
  action?: ReactNode;
}

/**
 * An ordered checklist inside a card that shows one step at a time. The open step is the first
 * one that is not done; it alone shows its hint and its action. Done steps shrink to their title
 * and result, later steps to their title, so the reader sees where they are, what it took, and
 * how much is left without reading anything twice.
 *
 * The component decides which step is open, never the caller: a list that could open two steps
 * would be two next actions.
 *
 * `Steps` is the other ordered shape: whole cards joined by a rail, every one of them open.
 */
export function ProgressSteps({ label, steps }: { label: string; steps: readonly ProgressStep[] }) {
  const open = steps.findIndex(({ state }) => state !== "done");
  return (
    <ol aria-label={label} className="grid">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const isOpen = index === open;
        return (
          <li
            key={step.key}
            aria-current={isOpen ? "step" : undefined}
            className="group grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3"
          >
            <span aria-hidden="true" className="flex flex-col items-center gap-1">
              <Marker state={step.state} number={index + 1} open={isOpen} />
              {last ? null : (
                <span
                  className={cn(
                    "w-px flex-1",
                    step.state === "done" ? "bg-success/30" : "bg-border",
                  )}
                />
              )}
            </span>
            <div className={cn("grid min-w-0 gap-3 group-last:pb-0", isOpen ? "pb-6" : "pb-4")}>
              <div className="flex min-h-6 min-w-0 items-center justify-between gap-3">
                <span
                  className={cn("truncate", isOpen ? "text-foreground" : "text-muted-foreground")}
                >
                  {step.title}
                  <span className="sr-only">{STATE_LABEL[step.state]}</span>
                </span>
                {step.result === undefined ? null : (
                  <span className="min-w-0 truncate text-muted-foreground">{step.result}</span>
                )}
              </div>
              {isOpen ? (
                <>
                  {/* The hint reads as the title's second line: `-mt-2` takes the row gap
                      back down to the distance a `TwoLine` keeps between its lines. */}
                  {step.hint === undefined ? null : (
                    <p className="-mt-2 text-muted-foreground">{step.hint}</p>
                  )}
                  {step.action === undefined ? null : <div className="min-w-0">{step.action}</div>}
                </>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const STATE_LABEL: Record<ProgressStepState, string> = {
  done: ", done",
  todo: ", to do",
  blocked: ", needs attention",
};

function Marker({
  state,
  number,
  open,
}: {
  state: ProgressStepState;
  number: number;
  open: boolean;
}) {
  if (state === "done") {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-success-surface text-success">
        <Check className="size-3.5" strokeWidth={2.5} />
      </span>
    );
  }
  if (state === "blocked") {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-warning-surface text-warning">
        <span className="text-xs">!</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full border text-xs tabular-nums",
        open ? "border-foreground text-foreground" : "text-extra-muted-foreground",
      )}
    >
      {number}
    </span>
  );
}
