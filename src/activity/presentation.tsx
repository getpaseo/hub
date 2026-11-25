import { executionLinkPath } from "../agent-executions/link.js";
import type { StatusTone } from "../components/app/status-pill.js";
import type { ProviderEventDropReasonCode } from "../triggers/drop-reason.js";
import type { ActivityProvider, ActivityRange, RunStatus } from "./query-contract.js";
import { PAYLOAD_PREVIEW_CHARACTERS } from "./store.js";

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

/** What an event's resource is called by the provider it came from. */
const RESOURCE_LABELS: Readonly<Record<ActivityProvider, string>> = {
  github: "Repository",
  slack: "Workspace",
  discord: "Server",
  linear: "Project",
  schedule: "Resource",
  webhook: "Resource",
  manual: "Resource",
};

export function resourceLabel(provider: ActivityProvider): string {
  return RESOURCE_LABELS[provider];
}

/** Said beside stored JSON the drawer shows only the start of. */
export const PREVIEW_CUT = `Preview cut at ${PAYLOAD_PREVIEW_CHARACTERS.toLocaleString("en-US")} characters`;

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

/**
 * The agent session a run's drawer offers: the newest step that reached an agent. A later
 * step can be skipped or never reach one, so the last step is not the answer. The Session row
 * and Open in Paseo both read this, so they name the same session.
 */
export function runSession<Execution extends { daemonAgentId: string | null }>(
  steps: readonly { execution: Execution | null }[],
): (Execution & { daemonAgentId: string }) | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const execution = steps[index]?.execution;
    if (execution != null && execution.daemonAgentId !== null) {
      return { ...execution, daemonAgentId: execution.daemonAgentId };
    }
  }
  return undefined;
}

/**
 * Where Open in Paseo goes. Inside Hub the reader already signed in, so the `paseo://` link opens
 * the agent in one click. Hub's open page is for links posted outside Hub, and for an execution
 * whose daemon or agent Hub cannot name yet.
 */
export function sessionLink(session: { id: string; deepLink: string | null }): string {
  return session.deepLink ?? executionLinkPath(session.id);
}

/** The launch requested these settings. Activity does not track the agent's current visibility. */
export function sessionVisibility(session: {
  background: boolean;
  autoArchive: boolean;
}): string | undefined {
  const notes: string[] = [];
  if (session.background) {
    notes.push(
      "This run requested a background workspace. If the agent is hidden, turn on Show background in Paseo.",
    );
  }
  if (session.autoArchive) {
    notes.push(
      "Auto-archive is on for this run. Hub skips archiving if another run is using the agent.",
    );
  }
  return notes.length === 0 ? undefined : notes.join(" ");
}
