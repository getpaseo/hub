/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop -- detail rows and click handlers are scoped to each rendered trigger/execution */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { DataCell, DataRow } from "../components/app/data-table.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { StatusPill, type StatusTone } from "../components/app/status-pill.js";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import type { ProjectDashboard } from "./dashboard.js";
import { executionResult, triggerPayload } from "./functions.js";

type ProjectSnapshot = Awaited<ReturnType<ProjectDashboard["projectSnapshot"]>>;
export type TriggerItem = ProjectSnapshot["activity"][number];
export type ExecutionItem = ProjectSnapshot["executions"][number];
export interface ProjectScope {
  organizationSlug: string;
  projectSlug: string;
}

/** One provider event, one line: what happened, who did it, when. */
export function EventRow({ event, onSelect }: { event: TriggerItem; onSelect: () => void }) {
  const meta = [event.repo, event.summary.actor === null ? null : `@${event.summary.actor}`]
    .filter((value): value is string => value !== null)
    .join(" · ");
  return (
    <DataRow onSelect={onSelect}>
      <DataCell>
        <div className="flex items-center gap-2.5">
          <span className="shrink-0 text-muted-foreground">
            <ProviderGlyph provider={event.summary.provider} />
          </span>
          <div className="grid min-w-0 gap-0.5">
            <span className="truncate text-sm font-medium">{event.summary.headline}</span>
            {meta === "" ? null : (
              <span className="truncate text-xs text-muted-foreground">{meta}</span>
            )}
          </div>
        </div>
      </DataCell>
      <DataCell>
        <StatusPill tone={outcomeTone(event)}>{outcomeLabel(event)}</StatusPill>
      </DataCell>
      <DataCell muted align="end">
        <RelativeTime value={event.receivedAt} />
      </DataCell>
    </DataRow>
  );
}

/** One agent run, one line: what triggered it, who ran it, how it went. */
export function ExecutionRow({
  execution,
  trigger,
  onSelect,
  onSelectTrigger,
}: {
  execution: ExecutionItem;
  trigger: TriggerItem | undefined;
  onSelect: () => void;
  onSelectTrigger?: () => void;
}) {
  return (
    <DataRow onSelect={onSelect}>
      <DataCell>
        <div className="grid min-w-0 gap-0.5">
          <span className="truncate text-sm font-medium">{runLabel(execution)}</span>
          {execution.triggerName === null ? null : (
            <button
              type="button"
              disabled={trigger === undefined}
              onClick={(event) => {
                event.stopPropagation();
                onSelectTrigger?.();
              }}
              className="w-fit truncate text-xs text-muted-foreground underline-offset-2 enabled:hover:text-foreground enabled:hover:underline disabled:cursor-default"
            >
              {execution.triggerName}
            </button>
          )}
        </div>
      </DataCell>
      <DataCell>
        <StatusPill tone={executionTone(execution.status)}>{execution.status}</StatusPill>
      </DataCell>
      <DataCell muted>{execution.daemon?.displayName ?? execution.daemon?.slug ?? "—"}</DataCell>
      <DataCell muted align="end">
        <div className="grid justify-items-end gap-0.5">
          <RelativeTime value={execution.startedAt} />
          {execution.durationMs === null ? null : (
            <span className="text-xs">{formatDuration(execution.durationMs)}</span>
          )}
        </div>
      </DataCell>
    </DataRow>
  );
}

export function TriggerDetailSheet({
  trigger,
  scope,
  onOpenChange,
}: {
  trigger: TriggerItem | undefined;
  /** Omitted for triggers with no owning project (e.g. unrouted events) — raw payload isn't fetchable there. */
  scope?: ProjectScope;
  onOpenChange: (open: boolean) => void;
}) {
  const loadPayload = useServerFn(triggerPayload);
  const payload = useQuery({
    queryKey: ["trigger-payload", scope?.organizationSlug, scope?.projectSlug, trigger?.id],
    queryFn: () => {
      if (trigger === undefined || scope === undefined) throw new Error("trigger unavailable");
      return loadPayload({ data: { ...scope, triggerId: trigger.id } });
    },
    enabled: trigger !== undefined && scope !== undefined,
  });
  return (
    <Sheet open={trigger !== undefined} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 overflow-y-auto">
        {trigger === undefined ? null : (
          <>
            <SheetHeader>
              <SheetTitle>{trigger.summary.headline}</SheetTitle>
              <SheetDescription>
                {providerLabel(trigger.summary.provider)} ·{" "}
                <RelativeTime value={trigger.receivedAt} />
              </SheetDescription>
            </SheetHeader>
            <div className="grid gap-4 p-4 pt-0 text-sm">
              <DetailGrid
                rows={[
                  ["Source", trigger.source],
                  ["Repository", trigger.repo],
                  ["Actor", trigger.summary.actor === null ? null : `@${trigger.summary.actor}`],
                  ["Matched trigger", trigger.matchedTriggerName],
                  ["Outcome", outcomeLabel(trigger)],
                  ["Dropped reason", trigger.droppedReason],
                ]}
              />
              {trigger.summary.externalUrl === null ? null : (
                <a
                  href={trigger.summary.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-primary underline underline-offset-2"
                >
                  Open on {providerLabel(trigger.summary.provider)}
                </a>
              )}
              <RawJson
                label="Raw payload"
                value={payload.data?.status === "ok" ? payload.data.data : null}
              />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function ExecutionDetailSheet({
  execution,
  scope,
  onOpenChange,
}: {
  execution: ExecutionItem | undefined;
  scope: ProjectScope;
  onOpenChange: (open: boolean) => void;
}) {
  const loadResult = useServerFn(executionResult);
  const result = useQuery({
    queryKey: ["execution-result", scope.organizationSlug, scope.projectSlug, execution?.id],
    queryFn: () => {
      if (execution === undefined) throw new Error("execution unavailable");
      return loadResult({ data: { ...scope, executionId: execution.id } });
    },
    enabled: execution !== undefined,
  });
  return (
    <Sheet open={execution !== undefined} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 overflow-y-auto">
        {execution === undefined ? null : (
          <>
            <SheetHeader>
              <SheetTitle>{runLabel(execution)}</SheetTitle>
              <SheetDescription>
                Started <RelativeTime value={execution.startedAt} />
              </SheetDescription>
            </SheetHeader>
            <div className="grid gap-4 p-4 pt-0 text-sm">
              <DetailGrid
                rows={[
                  ["Status", execution.status],
                  ["Trigger", execution.triggerName],
                  ["Daemon", execution.daemon?.displayName ?? execution.daemon?.slug ?? null],
                  [
                    "Duration",
                    execution.durationMs === null
                      ? "In progress"
                      : formatDuration(execution.durationMs),
                  ],
                  ["Configuration revision", execution.configurationRevisionId],
                ]}
              />
              <RawJson
                label="Result"
                value={result.data?.status === "ok" ? result.data.data : null}
              />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DetailGrid({ rows }: { rows: readonly [string, string | null][] }) {
  const populated = rows.filter((row): row is [string, string] => row[1] !== null);
  if (populated.length === 0) return null;
  return (
    <dl className="grid gap-2">
      {populated.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[9rem_1fr] gap-2">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 truncate font-mono text-xs">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RawJson({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <details className="rounded-md border">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
        {label}
      </summary>
      <pre className="max-h-72 overflow-auto border-t bg-muted p-3 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function runLabel(execution: ExecutionItem): string {
  if (execution.agent === null) return `Execution ${execution.configurationRevisionId.slice(0, 8)}`;
  return execution.agent.model === null
    ? execution.agent.provider
    : `${execution.agent.provider} · ${execution.agent.model}`;
}

function providerLabel(provider: TriggerItem["summary"]["provider"]): string {
  if (provider === "github") return "GitHub";
  if (provider === "discord") return "Discord";
  if (provider === "slack") return "Slack";
  return "Manual";
}

export type OutcomeKey = "dropped" | "running" | "succeeded" | "failed" | "accepted" | "unmatched";

export function outcomeKey(event: TriggerItem): OutcomeKey {
  if (event.droppedReason !== null) return "dropped";
  if (event.lifecycleState !== null) return event.lifecycleState;
  if (event.matchedTriggerName !== null) return "accepted";
  return "unmatched";
}

function outcomeLabel(event: TriggerItem): string {
  return statusLabel(outcomeKey(event));
}

const OUTCOME_TONES: Record<OutcomeKey, StatusTone> = {
  dropped: "neutral",
  unmatched: "neutral",
  accepted: "neutral",
  running: "warning",
  succeeded: "success",
  failed: "danger",
};

function outcomeTone(event: TriggerItem): StatusTone {
  return OUTCOME_TONES[outcomeKey(event)];
}

function executionTone(status: ExecutionItem["status"]): StatusTone {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "running" || status === "spawning") return "warning";
  return "neutral";
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${String(totalMinutes)}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(minutes)}m`;
}
