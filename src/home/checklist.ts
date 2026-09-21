import type { HomeSnapshot } from "./dashboard.js";

/**
 * What the reader has to do next, derived from what the organization has. Every state is a fact
 * about records — a connection row, a daemon and its permissions, a trigger, a run — so the list
 * cannot get ahead of the organization and cannot be dismissed into a lie.
 */
export type ChecklistStep =
  | {
      key: "app";
      /** `setup`: this Hub has no provider app at all, so there is nothing to connect yet. */
      state: "done" | "pending" | "setup";
    }
  | {
      key: "daemon";
      /** `cannotRun`: a daemon is enrolled, but none was allowed to run Hub automations. */
      state: "done" | "pending" | "cannotRun";
    }
  | { key: "trigger"; state: "done" | "pending" }
  | { key: "run"; state: "done" | "pending" };

export interface Checklist {
  steps: readonly ChecklistStep[];
  completed: number;
  complete: boolean;
}

export interface ChecklistFacts {
  /** Whether any provider app (GitHub, Slack, Discord, Linear) is set up on this Hub. */
  appsConfigured: boolean;
  snapshot: Pick<HomeSnapshot, "connections" | "daemons" | "triggers" | "runs">;
}

function appState(
  appsConfigured: boolean,
  snapshot: ChecklistFacts["snapshot"],
): Extract<ChecklistStep, { key: "app" }>["state"] {
  if (snapshot.connections.length > 0) return "done";
  return appsConfigured ? "pending" : "setup";
}

function daemonState(
  snapshot: ChecklistFacts["snapshot"],
): Extract<ChecklistStep, { key: "daemon" }>["state"] {
  if (snapshot.daemons.some((daemon) => daemon.canExecute)) return "done";
  return snapshot.daemons.length > 0 ? "cannotRun" : "pending";
}

export function deriveChecklist({ appsConfigured, snapshot }: ChecklistFacts): Checklist {
  const steps: ChecklistStep[] = [
    { key: "app", state: appState(appsConfigured, snapshot) },
    { key: "daemon", state: daemonState(snapshot) },
    { key: "trigger", state: snapshot.triggers.length > 0 ? "done" : "pending" },
    { key: "run", state: snapshot.runs.length > 0 ? "done" : "pending" },
  ];
  const completed = steps.filter((step) => step.state === "done").length;
  return { steps, completed, complete: completed === steps.length };
}
