import type { AuthServer } from "../auth/server.js";
import type { Database } from "../db/types.js";
import { displayFailureReason } from "../entitlements/denial.js";
import { resolveRouteTenant } from "../projects/access.js";
import { formatInvocationRejection } from "../triggers/invocation.js";
import { ACTIVITY_PAGE_SIZE, type ActivityQuery } from "./query-contract.js";
import type {
  ActivityFilterOptions,
  ActivityRun,
  ActivityRunDetail,
  ActivityStep,
  UnmatchedEvent,
  UnmatchedEventDetail,
} from "./store.js";

/** A record as the browser receives it: dates travel as ISO strings. */
type Wire<Row, Dates extends keyof Row> = Omit<Row, Dates> & {
  [Key in Dates]: null extends Row[Key] ? string | null : string;
};

export type ActivityRunView = Wire<ActivityRun, "receivedAt">;
export type UnmatchedEventView = Wire<UnmatchedEvent, "receivedAt">;

interface ListPage<Row> {
  rows: Row[];
  total: number;
  totalCapped: boolean;
  hasNext: boolean;
  page: number;
  pageSize: number;
}

export type ActivityList =
  | ({ view: "runs" } & ListPage<ActivityRunView>)
  | ({ view: "unmatched" } & ListPage<UnmatchedEventView>);

export interface ActivitySnapshot {
  organization: { slug: string };
  list: ActivityList;
  filters: ActivityFilterOptions;
}

export type ActivityStepView = Omit<
  Wire<ActivityStep, "startedAt" | "completedAt">,
  "failureReason"
> & { failureReason: string | null };

export type ActivityRunDetailView = Omit<
  Wire<ActivityRunDetail, "receivedAt" | "createdAt" | "completedAt">,
  "rejection" | "steps"
> & { steps: ActivityStepView[] };

export type UnmatchedEventDetailView = Wire<UnmatchedEventDetail, "receivedAt">;

export type ActivityRecord =
  | { kind: "run"; run: ActivityRunDetailView }
  | { kind: "unmatched"; event: UnmatchedEventDetailView }
  | { kind: "missing" };

/**
 * The organization's runs and unmatched events, as Activity lists and opens them. The query is
 * already in its parsed shape: the URL contract owns every default and every bound.
 */
export class ActivityDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async snapshot(
    request: Request,
    organizationSlug: string,
    query: ActivityQuery,
  ): Promise<ActivitySnapshot> {
    const organization = await this.organization(request, organizationSlug);
    const now = this.now();
    const [list, filters] = await Promise.all([
      this.list(organization.id, query, now),
      this.database.activity.filterOptions(organization.id),
    ]);
    return { organization: { slug: organization.slug }, list, filters };
  }

  async record(
    request: Request,
    organizationSlug: string,
    target: { kind: "run" | "unmatched"; id: string },
  ): Promise<ActivityRecord> {
    const organization = await this.organization(request, organizationSlug);
    if (target.kind === "run") {
      const run = await this.database.activity.findRun(organization.id, target.id, this.now());
      return run === undefined ? { kind: "missing" } : { kind: "run", run: runDetailView(run) };
    }
    const event = await this.database.activity.findUnmatched(organization.id, target.id);
    return event === undefined
      ? { kind: "missing" }
      : { kind: "unmatched", event: { ...event, receivedAt: event.receivedAt.toISOString() } };
  }

  private async organization(request: Request, organizationSlug: string) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    return tenant.organization;
  }

  private async list(organizationId: string, query: ActivityQuery, now: Date) {
    const paging = { page: query.page, pageSize: ACTIVITY_PAGE_SIZE };
    if (query.view === "unmatched") {
      const page = await this.database.activity.listUnmatched(organizationId, query, now);
      return {
        view: "unmatched" as const,
        ...page,
        ...paging,
        rows: page.rows.map(receivedOnWire),
      };
    }
    const page = await this.database.activity.listRuns(organizationId, query, now);
    return {
      view: "runs" as const,
      ...page,
      ...paging,
      rows: page.rows.map(receivedOnWire),
    };
  }
}

function runDetailView(run: ActivityRunDetail): ActivityRunDetailView {
  const { rejection, steps, ...rest } = run;
  return {
    ...rest,
    failureReason:
      rejection === null
        ? displayFailureReason(run.failureReason)
        : formatInvocationRejection(rejection),
    receivedAt: run.receivedAt.toISOString(),
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    steps: steps.map(stepView),
  };
}

function receivedOnWire<Row extends { receivedAt: Date }>(row: Row): Wire<Row, "receivedAt"> {
  const { receivedAt, ...rest } = row;
  return { ...rest, receivedAt: receivedAt.toISOString() };
}

function stepView(step: ActivityStep): ActivityStepView {
  return {
    ...step,
    failureReason: displayFailureReason(step.failureReason),
    startedAt: step.startedAt?.toISOString() ?? null,
    completedAt: step.completedAt?.toISOString() ?? null,
  };
}
