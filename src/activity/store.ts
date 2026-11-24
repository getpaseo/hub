import type { ProviderEventDropReasonCode } from "../triggers/drop-reason.js";
import type { InvocationRejection } from "../triggers/invocation.js";
import type { ActivityProvider, ActivityQuery, RunStatus } from "./query-contract.js";

/**
 * The organization's run and event history as the dashboard reads it. Every list and every
 * aggregate here selects scalar columns only: webhook payloads, prompts, and run contexts are
 * TOASTed JSON that Postgres reads only when a query names them, and only the single-record
 * reads below name them.
 */
export interface ActivityStore {
  listRuns(
    organizationId: string,
    query: ActivityQuery,
    now: Date,
  ): Promise<ActivityPage<ActivityRun>>;
  listUnmatched(
    organizationId: string,
    query: ActivityQuery,
    now: Date,
  ): Promise<ActivityPage<UnmatchedEvent>>;
  /** What the filter menus offer: every trigger and daemon the organization has had. */
  filterOptions(organizationId: string): Promise<ActivityFilterOptions>;
  findRun(organizationId: string, runId: string, now: Date): Promise<ActivityRunDetail | undefined>;
  findUnmatched(
    organizationId: string,
    receiptId: string,
  ): Promise<UnmatchedEventDetail | undefined>;
  /** The run an agent execution belongs to, for links that only know the execution. */
  findRunIdForExecution(executionId: string): Promise<string | undefined>;
  /**
   * Runs since `since`, counted exactly and in the same terms the Runs list filters by, so a
   * figure and the list it links to always agree.
   */
  summarize(organizationId: string, since: Date, triggerLimit: number): Promise<ActivitySummary>;
  /** Runs since `since` by the provider of the event that started them, in the same terms. */
  summarizeProviders(organizationId: string, since: Date): Promise<ProviderActivity[]>;
  /** The organization's newest run, however old. */
  latestRun(organizationId: string): Promise<LatestRun | undefined>;
  /** Each trigger's newest run, however old. A trigger that never ran is absent. */
  lastRuns(organizationId: string): Promise<TriggerLastRun[]>;
}

export interface TriggerLastRun {
  triggerId: string;
  status: RunStatus;
  receivedAt: Date;
}

export interface ProviderActivity {
  provider: ActivityProvider;
  runs: number;
  /** Runs that failed, timed out, or were rejected. */
  failed: number;
}

export interface ActivitySummary {
  /** Runs by status. Every status is present, zero when none ended that way. */
  statuses: Record<RunStatus, number>;
  /**
   * The busiest triggers in the window, then the quiet ones by name, at most `triggerLimit`. A
   * trigger with no runs in the window is still a trigger the organization has.
   */
  triggers: TriggerActivity[];
  /** Runs per daemon. A run counts for each daemon one of its steps ran on. */
  daemons: { id: string; runs: number }[];
}

export interface TriggerActivity {
  id: string;
  name: string;
  runs: number;
  /** Runs that failed, timed out, or were rejected. */
  failed: number;
  /** The newest run in the window. */
  lastRunAt: Date | null;
}

export interface LatestRun {
  triggerName: string;
  receivedAt: Date;
}

export interface ActivityPage<Row> {
  rows: Row[];
  /** Every row the filters match, or the cap when there are more than `totalCapped` admits. */
  total: number;
  /** True when `total` is a floor: a noisy event stream is counted only up to a cap. */
  totalCapped: boolean;
}

export interface ActivityRun {
  id: string;
  triggerId: string | null;
  triggerName: string;
  provider: ActivityProvider;
  source: string;
  repo: string | null;
  status: RunStatus;
  receivedAt: Date;
  /** Run time so far for a running run, its whole length once it ends. */
  durationMs: number;
  daemon: { id: string; slug: string } | null;
  agent: { provider: string; model: string | null } | null;
}

export interface UnmatchedEvent {
  id: string;
  provider: ActivityProvider;
  source: string;
  repo: string | null;
  deliveryId: string;
  receivedAt: Date;
  reason: ProviderEventDropReasonCode;
}

export interface ActivityFilterOptions {
  triggers: { id: string; name: string }[];
  daemons: { id: string; slug: string }[];
}

/** A receipt's payload as far as the drawer will show it. */
export interface PayloadPreview {
  /** Size of the stored JSON. */
  bytes: number;
  /** Indented JSON, cut at `PAYLOAD_PREVIEW_CHARACTERS`. */
  text: string;
  truncated: boolean;
}

export const PAYLOAD_PREVIEW_CHARACTERS = 65_536;

export interface ActivityRunDetail extends ActivityRun {
  deliveryId: string;
  outcome: "accepted" | "rejected";
  prompt: string;
  failureReason: string | null;
  rejection: InvocationRejection | null;
  createdAt: Date;
  completedAt: Date | null;
  payload: PayloadPreview;
  steps: ActivityStep[];
}

export interface ActivityStep {
  id: string;
  stepId: string;
  ordinal: number;
  status: "pending" | "running" | "succeeded" | "skipped" | "failed" | "timed_out";
  failureReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Indented JSON of what the step reported, cut at `PAYLOAD_PREVIEW_CHARACTERS`. */
  output: string | null;
  execution: {
    id: string;
    daemon: { id: string; slug: string } | null;
    agent: { provider: string; model: string | null } | null;
    /** The daemon's id for the agent; present once the agent exists and can be opened. */
    daemonAgentId: string | null;
    sessionAction: string | null;
  } | null;
}

export interface UnmatchedEventDetail extends UnmatchedEvent {
  connectionSlug: string | null;
  resourceId: string | null;
  payload: PayloadPreview;
}
