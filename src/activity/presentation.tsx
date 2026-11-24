import type { StatusTone } from "../components/app/status-pill.js";
import type { ProviderEventDropReasonCode } from "../triggers/drop-reason.js";
import type { ActivityRange, RunStatus } from "./query-contract.js";

/** How a run's state reads wherever a run is shown: green done, red ended badly, grey busy. */
export function runStatusTone(status: RunStatus): StatusTone {
  if (status === "succeeded") return "success";
  if (status === "running") return "neutral";
  return "danger";
}

/** How a workflow step's state reads in a run's step list. */
export function stepStatusTone(status: string): StatusTone {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out") return "danger";
  return "neutral";
}

/** `42s`, `1m 08s`, `2h 05m`: a run's length at a glance, to the second while that matters. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${pad(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${pad(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `14.2 KB`: the size of a stored payload. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const RANGE_LABELS: Readonly<Record<ActivityRange, string>> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

/** Where an unmatched event's reader goes to make the next one match. */
export type DropReasonNextStep = "create_trigger" | "view_triggers" | "check_integrations";

interface DropReasonPresentation {
  /** The pill: a few words, no period. */
  label: string;
  tone: StatusTone;
  /** What happened, for the drawer. */
  title: string;
  explanation: string;
  next: DropReasonNextStep;
}

/**
 * Why an event started no run, said for the reader rather than as the stored code. Only a
 * connection that is unavailable is a warning: the other three are Hub working as configured on
 * an event nobody asked for.
 */
export const DROP_REASONS: Readonly<Record<ProviderEventDropReasonCode, DropReasonPresentation>> = {
  no_project_route: {
    label: "No route for repo",
    tone: "neutral",
    title: "No trigger covers this repository",
    explanation: "The event came from a repository no trigger is set up for",
    next: "create_trigger",
  },
  no_trigger_for_source: {
    label: "No trigger for event",
    tone: "neutral",
    title: "No trigger listens for this event",
    explanation: "Triggers exist for this source, but none of them run on this event",
    next: "create_trigger",
  },
  trigger_filters_rejected: {
    label: "Filtered out",
    tone: "neutral",
    title: "Did not pass trigger filters",
    explanation: "A trigger listens for this event, but the event did not match its filters",
    next: "view_triggers",
  },
  configuration_unavailable: {
    label: "Connection unavailable",
    tone: "warning",
    title: "Connection or configuration unavailable",
    explanation: "Hub could not read the connection or trigger configuration for this event",
    next: "check_integrations",
  },
};
