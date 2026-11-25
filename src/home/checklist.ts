import type { HomeSnapshot } from "./dashboard.js";

/**
 * What the reader has to do next, derived from what the organization has. Every state is a fact
 * about records — a daemon and its permissions, a trigger, a run — so the list cannot get ahead
 * of the organization and cannot be dismissed into a lie.
 *
 * The daemon comes first because every trigger runs on one. An integration is not a step: a
 * webhook, a schedule, or a manual run needs none, so it sits beside the list as an offer.
 */
export type ChecklistStep =
  | {
      key: "daemon";
      /** `cannotRun`: a daemon is enrolled, but none was allowed to run Hub automations. */
      state: "done" | "pending" | "cannotRun";
    }
  | { key: "trigger"; state: "done" | "pending" }
  | { key: "run"; state: "done" | "pending" };

/** `setup`: this Hub has no provider app at all, so there is nothing to connect yet. */
export type IntegrationState = "done" | "pending" | "setup";

export interface Checklist {
  steps: readonly ChecklistStep[];
  completed: number;
  complete: boolean;
  integration: IntegrationState;
}

export type ChecklistFacts = Pick<
  HomeSnapshot,
  "appsConfigured" | "connections" | "daemons" | "triggers" | "latestRun"
>;

function integrationState(snapshot: ChecklistFacts): IntegrationState {
  if (snapshot.connections.length > 0) return "done";
  return snapshot.appsConfigured ? "pending" : "setup";
}

function daemonState(snapshot: ChecklistFacts): Extract<ChecklistStep, { key: "daemon" }>["state"] {
  if (snapshot.daemons.some((daemon) => daemon.canExecute)) return "done";
  return snapshot.daemons.length > 0 ? "cannotRun" : "pending";
}

export function deriveChecklist(snapshot: ChecklistFacts): Checklist {
  const steps: ChecklistStep[] = [
    { key: "daemon", state: daemonState(snapshot) },
    { key: "trigger", state: snapshot.triggers.length > 0 ? "done" : "pending" },
    { key: "run", state: snapshot.latestRun === null ? "pending" : "done" },
  ];
  const completed = steps.filter((step) => step.state === "done").length;
  return {
    steps,
    completed,
    complete: completed === steps.length,
    integration: integrationState(snapshot),
  };
}
