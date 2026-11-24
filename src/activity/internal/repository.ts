import type { QueryHandle } from "../../db/runtime/index.js";
import type { ProviderEventDropReasonCode } from "../../triggers/drop-reason.js";
import { parseInvocationRejection } from "../../triggers/invocation.js";
import {
  ACTIVITY_PAGE_SIZE,
  FAILED_RUN_STATUSES,
  rangeStart,
  type ActivityProvider,
  type ActivityQuery,
  type RunStatus,
} from "../query-contract.js";
import {
  PAYLOAD_PREVIEW_CHARACTERS,
  type ActivityFilterOptions,
  type ActivityPage,
  type ActivityRun,
  type ActivityRunDetail,
  type ActivityStep,
  type ActivityStore,
  type ActivitySummary,
  type LatestRun,
  type ProviderActivity,
  type TriggerLastRun,
  type PayloadPreview,
  type UnmatchedEvent,
  type UnmatchedEventDetail,
} from "../store.js";

/**
 * Unmatched events are counted only this far. A connected GitHub organization drops events for
 * every repository nobody routes, and an exact count of that stream is a full index scan for a
 * number nobody reads past "a lot".
 */
const UNMATCHED_COUNT_CAP = 1_000;

/**
 * Spelled exactly as the partial indexes' predicate, so the planner can prove a query implies it
 * and use them.
 */
const UNMATCHED_PREDICATE = `receipts.dropped_reason in ('no_project_route', 'no_trigger_for_source', 'trigger_filters_rejected', 'configuration_unavailable')`;

/**
 * Rank by how much a run asks of the reader, so the default descending sort puts busy runs first,
 * then the ways a run can end badly, then the runs that need nothing.
 */
const STATUS_ORDER = `array_position(array['succeeded', 'rejected', 'timed_out', 'failed', 'running']::text[], runs.status)`;

const RUN_DURATION_MS = `(extract(epoch from (coalesce(runs.completed_at, $NOW) - runs.created_at)) * 1000)::bigint`;

/**
 * The newest step of a run that reached an agent: the daemon it ran on and the agent it asked
 * for. A lateral read of one row per run, through the step's unique execution index.
 */
const LATEST_EXECUTION = `left join lateral (
    select executions.daemon_id, daemons.slug as daemon_slug,
           executions.launch_intent #>> '{agent,provider}' as agent_provider,
           executions.launch_intent #>> '{agent,model}' as agent_model
    from workflow_step_runs steps
    join agent_executions executions on executions.id = steps.agent_execution_id
    left join daemons on daemons.id = executions.daemon_id
    where steps.trigger_run_id = runs.id
    order by steps.ordinal desc
    limit 1
  ) execution on true`;

/**
 * Where each trigger of the organization in `$1` finds its runs. A trigger's own runs are in its
 * runtime project. A trigger migrated from a project also owns the runs that project's workflow
 * of the same former name made before the migration: those runs keep their original project
 * (docs/trigger-migration.md), so they are matched by the name the migration revision recorded.
 */
const TRIGGER_SOURCES = `(
  select id, name, runtime_project_id as project_id, null::text as former_name
  from organization_triggers
  where organization_id = $1
  union all
  select triggers.id, triggers.name,
         (revisions.source_evidence ->> 'legacyProjectId')::uuid as project_id,
         revisions.normalized_configuration #>> '{triggers,0,name}' as former_name
  from organization_trigger_revisions revisions
  join organization_triggers triggers on triggers.id = revisions.trigger_id
  where revisions.organization_id = $1 and revisions.source_kind = 'project_migration'
    and triggers.organization_id = $1
)`;

/** A run belongs to the trigger whose source it came from. */
const RUN_OF_TRIGGER = `runs.project_id = triggers.project_id
  and (triggers.former_name is null or runs.configured_trigger_name = triggers.former_name)`;

/** Runs with the event that started them, for reads that need the provider but not the trigger. */
const RUN_EVENT_FROM = `from trigger_runs runs
  join provider_event_receipts receipts
    on receipts.id = runs.provider_event_receipt_id
   and receipts.organization_id = runs.organization_id`;

const RUN_FROM = `${RUN_EVENT_FROM}
  left join ${TRIGGER_SOURCES} triggers on ${RUN_OF_TRIGGER}`;

/** A run that ended badly, in the terms Activity's failure filter uses. */
const FAILED_RUN = `runs.status in (${FAILED_RUN_STATUSES.map((status) => `'${status}'`).join(", ")})`;

/** A run's own columns, read over `RUN_FROM`. */
const RUN_COLUMNS = `runs.id, triggers.id as trigger_id,
  coalesce(triggers.name, runs.configured_trigger_name) as trigger_name,
  receipts.provider, receipts.source, receipts.repo, runs.status, receipts.received_at,
  ${RUN_DURATION_MS} as duration_ms`;

/** What `LATEST_EXECUTION` adds to a run. */
const EXECUTION_COLUMNS = `execution.daemon_id, execution.daemon_slug, execution.agent_provider,
  execution.agent_model`;

interface RunRow extends Record<string, unknown> {
  id: string;
  trigger_id: string | null;
  trigger_name: string;
  provider: ActivityProvider;
  source: string;
  repo: string | null;
  status: RunStatus;
  received_at: Date;
  duration_ms: string | number;
  daemon_id: string | null;
  daemon_slug: string | null;
  agent_provider: string | null;
  agent_model: string | null;
}

interface UnmatchedRow extends Record<string, unknown> {
  id: string;
  provider: ActivityProvider;
  source: string;
  repo: string | null;
  delivery_id: string;
  received_at: Date;
  dropped_reason: ProviderEventDropReasonCode;
}

interface PayloadRow {
  payload_bytes: number;
  payload_preview: string;
  payload_truncated: boolean;
}

/**
 * Stored JSON indented once, as `<name>.printed`. `offset 0` keeps the planner from folding the
 * subquery into the preview's two uses of it, which would print the JSON twice.
 */
function printed(json: string, name: string): string {
  return `cross join lateral (select jsonb_pretty(${json}) as printed offset 0) ${name}`;
}

/** The first `PAYLOAD_PREVIEW_CHARACTERS` of JSON `printed` as `name`, and whether it goes on. */
function previewColumns(name: string, prefix: string): string {
  const cap = String(PAYLOAD_PREVIEW_CHARACTERS);
  return `left(${name}.printed, ${cap}) as ${prefix}_preview,
  length(${name}.printed) > ${cap} as ${prefix}_truncated`;
}

const PAYLOAD_PRINTED = printed("receipts.payload", "payload_printed");

const PAYLOAD_COLUMNS = `octet_length(receipts.payload::text) as payload_bytes,
  ${previewColumns("payload_printed", "payload")}`;

export class ActivityRepository implements ActivityStore {
  constructor(private readonly runtime: QueryHandle) {}

  async listRuns(
    organizationId: string,
    query: ActivityQuery,
    now: Date,
  ): Promise<ActivityPage<ActivityRun>> {
    const params = new Parameters([organizationId]);
    const where = runConditions(query, now, params);
    const nowParameter = params.add(now);
    const limit = params.add(PAGE_READ);
    const offset = params.add(pageOffset(query.page));
    const order = runOrder(query).replaceAll("$NOW", nowParameter);
    // The page is chosen first and only its runs look up their execution. The inner query is
    // named `runs` and carries the columns the order reads, so the same order applies to both.
    const [rows, count] = await Promise.all([
      this.runtime.query<RunRow>(
        `select runs.*, ${EXECUTION_COLUMNS}
         from (
           select ${RUN_COLUMNS.replaceAll("$NOW", nowParameter)},
                  runs.created_at, runs.completed_at
           ${RUN_FROM}
           where ${where}
           order by ${order}
           limit ${limit} offset ${offset}
         ) runs
         ${LATEST_EXECUTION}
         order by ${order}`,
        params.values,
      ),
      this.runtime.query<{ total: number }>(
        `select count(*)::int as total ${RUN_FROM} where ${where}`,
        params.values.slice(0, params.countBefore(nowParameter)),
      ),
    ]);
    return toPage(rows.rows.map(toRun), query.page, count.rows[0]?.total ?? 0, Infinity);
  }

  async listUnmatched(
    organizationId: string,
    query: ActivityQuery,
    now: Date,
  ): Promise<ActivityPage<UnmatchedEvent>> {
    const params = new Parameters([organizationId]);
    const where = unmatchedConditions(query, now, params);
    const direction = query.dir === "asc" ? "asc" : "desc";
    const limit = params.add(PAGE_READ);
    const offset = params.add(pageOffset(query.page));
    const [rows, count] = await Promise.all([
      this.runtime.query<UnmatchedRow>(
        `select receipts.id, receipts.provider, receipts.source, receipts.repo,
                receipts.delivery_id, receipts.received_at, receipts.dropped_reason
         from provider_event_receipts receipts
         where ${where}
         order by receipts.received_at ${direction}, receipts.id ${direction}
         limit ${limit} offset ${offset}`,
        params.values,
      ),
      this.runtime.query<{ total: number }>(
        `select count(*)::int as total from (
           select 1 from provider_event_receipts receipts where ${where}
           limit ${String(UNMATCHED_COUNT_CAP + 1)}
         ) capped`,
        params.values.slice(0, params.values.length - 2),
      ),
    ]);
    return toPage(
      rows.rows.map(toUnmatched),
      query.page,
      count.rows[0]?.total ?? 0,
      UNMATCHED_COUNT_CAP,
    );
  }

  async filterOptions(organizationId: string): Promise<ActivityFilterOptions> {
    const [triggers, daemons] = await Promise.all([
      this.runtime.query<{ id: string; name: string }>(
        `select id, name from organization_triggers where organization_id = $1 order by name`,
        [organizationId],
      ),
      this.runtime.query<{ id: string; slug: string }>(
        `select id, slug from daemons where organization_id = $1 order by slug`,
        [organizationId],
      ),
    ]);
    return { triggers: triggers.rows, daemons: daemons.rows };
  }

  async findRun(
    organizationId: string,
    runId: string,
    now: Date,
  ): Promise<ActivityRunDetail | undefined> {
    const {
      rows: [row],
    } = await this.runtime.query<
      RunRow &
        PayloadRow & {
          delivery_id: string;
          outcome: "accepted" | "rejected";
          prompt: string;
          failure_reason: string | null;
          rejection: unknown;
          created_at: Date;
          completed_at: Date | null;
        }
    >(
      `select ${RUN_COLUMNS.replaceAll("$NOW", "$3")}, ${EXECUTION_COLUMNS},
              receipts.delivery_id, runs.outcome, runs.prompt, runs.failure_reason, runs.rejection,
              runs.created_at, runs.completed_at, ${PAYLOAD_COLUMNS}
       ${RUN_FROM}
       ${LATEST_EXECUTION}
       ${PAYLOAD_PRINTED}
       where runs.organization_id = $1 and runs.id = $2`,
      [organizationId, runId, now],
    );
    if (row === undefined) return undefined;
    const steps = await this.runtime.query<StepRow>(
      `select steps.id, steps.step_id, steps.ordinal, steps.status, steps.failure_reason,
              steps.started_at, steps.completed_at,
              ${previewColumns("output_printed", "output")},
              executions.id as execution_id, executions.daemon_agent_id,
              executions.agent_session_action,
              executions.launch_intent #>> '{agent,provider}' as agent_provider,
              executions.launch_intent #>> '{agent,model}' as agent_model,
              daemons.id as daemon_id, daemons.slug as daemon_slug
       from workflow_step_runs steps
       left join agent_executions executions on executions.id = steps.agent_execution_id
       left join daemons on daemons.id = executions.daemon_id
       ${printed("steps.output", "output_printed")}
       where steps.trigger_run_id = $1
       order by steps.ordinal`,
      [row.id],
    );
    return {
      ...toRun(row),
      deliveryId: row.delivery_id,
      outcome: row.outcome,
      prompt: row.prompt,
      failureReason: row.failure_reason,
      rejection: row.rejection === null ? null : parseInvocationRejection(row.rejection),
      createdAt: row.created_at,
      completedAt: row.completed_at,
      payload: toPayload(row),
      steps: steps.rows.map(toStep),
    };
  }

  async findUnmatched(
    organizationId: string,
    receiptId: string,
  ): Promise<UnmatchedEventDetail | undefined> {
    const {
      rows: [row],
    } = await this.runtime.query<
      UnmatchedRow & PayloadRow & { connection_slug: string | null; resource_id: string | null }
    >(
      `select receipts.id, receipts.provider, receipts.source, receipts.repo,
              receipts.delivery_id, receipts.received_at, receipts.dropped_reason,
              receipts.resource_id,
              coalesce(github.slug, slack.slug, discord.slug, linear.slug) as connection_slug,
              ${PAYLOAD_COLUMNS}
       from provider_event_receipts receipts
       left join github_connections github
         on receipts.provider = 'github' and github.id = receipts.connection_id
       left join slack_connections slack
         on receipts.provider = 'slack' and slack.id = receipts.connection_id
       left join discord_connections discord
         on receipts.provider = 'discord' and discord.id = receipts.connection_id
       left join linear_connections linear
         on receipts.provider = 'linear' and linear.id = receipts.connection_id
       ${PAYLOAD_PRINTED}
       where receipts.organization_id = $1 and receipts.id = $2 and ${UNMATCHED_PREDICATE}
         and not exists (
           select 1 from trigger_runs runs where runs.provider_event_receipt_id = receipts.id
         )`,
      [organizationId, receiptId],
    );
    if (row === undefined) return undefined;
    return {
      ...toUnmatched(row),
      connectionSlug: row.connection_slug,
      resourceId: row.resource_id,
      payload: toPayload(row),
    };
  }

  async findRunIdForExecution(executionId: string): Promise<string | undefined> {
    const {
      rows: [row],
    } = await this.runtime.query<{ trigger_run_id: string }>(
      `select trigger_run_id from workflow_step_runs where agent_execution_id = $1`,
      [executionId],
    );
    return row?.trigger_run_id;
  }

  async summarize(
    organizationId: string,
    since: Date,
    triggerLimit: number,
  ): Promise<ActivitySummary> {
    const failed = FAILED_RUN;
    const [statuses, triggers, daemons] = await Promise.all([
      this.runtime.query<{ status: RunStatus; runs: number }>(
        // Every run has its receipt (`trigger_runs_receipt_organization_fk`), so the runs alone
        // count what the list counts.
        `select runs.status, count(*)::int as runs
         from trigger_runs runs
         where runs.organization_id = $1 and runs.created_at >= $2
         group by runs.status`,
        [organizationId, since],
      ),
      // From the triggers, not the runs: a trigger that was quiet this week is still listed.
      this.runtime.query<{
        id: string;
        name: string;
        run_count: number;
        failed: number;
        last_run_at: Date | null;
      }>(
        `select triggers.id, triggers.name, count(runs.id)::int as run_count,
                (count(runs.id) filter (where ${failed}))::int as failed,
                max(runs.created_at) as last_run_at
         from ${TRIGGER_SOURCES} triggers
         left join trigger_runs runs
           on ${RUN_OF_TRIGGER}
          and runs.organization_id = $1
          and runs.created_at >= $2
         group by triggers.id, triggers.name
         order by run_count desc, triggers.name, triggers.id
         limit $3`,
        [organizationId, since, triggerLimit],
      ),
      this.runtime.query<{ id: string; runs: number }>(
        `select executions.daemon_id as id, count(distinct runs.id)::int as runs
         from trigger_runs runs
         join workflow_step_runs steps on steps.trigger_run_id = runs.id
         join agent_executions executions on executions.id = steps.agent_execution_id
         where runs.organization_id = $1 and runs.created_at >= $2
           and executions.daemon_id is not null
         group by executions.daemon_id`,
        [organizationId, since],
      ),
    ]);
    const counts = new Map(statuses.rows.map((row) => [row.status, row.runs]));
    const count = (status: RunStatus) => counts.get(status) ?? 0;
    return {
      statuses: {
        running: count("running"),
        succeeded: count("succeeded"),
        failed: count("failed"),
        timed_out: count("timed_out"),
        rejected: count("rejected"),
      },
      triggers: triggers.rows.map((row) => ({
        id: row.id,
        name: row.name,
        runs: row.run_count,
        failed: row.failed,
        lastRunAt: row.last_run_at,
      })),
      daemons: daemons.rows,
    };
  }

  async summarizeProviders(organizationId: string, since: Date): Promise<ProviderActivity[]> {
    const { rows } = await this.runtime.query<{
      provider: ActivityProvider;
      runs: number;
      failed: number;
    }>(
      `select receipts.provider, count(*)::int as runs,
              (count(*) filter (where ${FAILED_RUN}))::int as failed
       ${RUN_EVENT_FROM}
       where runs.organization_id = $1 and runs.created_at >= $2
       group by receipts.provider
       order by receipts.provider`,
      [organizationId, since],
    );
    return rows.map(({ provider, runs, failed }) => ({ provider, runs, failed }));
  }

  async latestRun(organizationId: string): Promise<LatestRun | undefined> {
    const {
      rows: [row],
    } = await this.runtime.query<{ trigger_name: string; received_at: Date }>(
      `select coalesce(triggers.name, runs.configured_trigger_name) as trigger_name,
              receipts.received_at
       ${RUN_FROM}
       where runs.organization_id = $1
       order by runs.created_at desc, runs.id desc
       limit 1`,
      [organizationId],
    );
    return row === undefined
      ? undefined
      : { triggerName: row.trigger_name, receivedAt: row.received_at };
  }

  async lastRuns(organizationId: string): Promise<TriggerLastRun[]> {
    // One indexed read per trigger source, through `trigger_runs_project_created_idx`, then the
    // newest of a migrated trigger's two sources.
    const { rows } = await this.runtime.query<{
      trigger_id: string;
      status: RunStatus;
      received_at: Date;
    }>(
      `select trigger_id, status, received_at from (
         select distinct on (triggers.id)
                triggers.id as trigger_id, triggers.name, latest.status, latest.received_at
         from ${TRIGGER_SOURCES} triggers
         join lateral (
           select runs.id, runs.status, runs.created_at, receipts.received_at
           from trigger_runs runs
           join provider_event_receipts receipts
             on receipts.id = runs.provider_event_receipt_id
            and receipts.organization_id = runs.organization_id
           where ${RUN_OF_TRIGGER}
             and runs.organization_id = $1
           order by runs.created_at desc, runs.id desc
           limit 1
         ) latest on true
         order by triggers.id, latest.created_at desc, latest.id desc
       ) newest
       order by name, trigger_id`,
      [organizationId],
    );
    return rows.map((row) => ({
      triggerId: row.trigger_id,
      status: row.status,
      receivedAt: row.received_at,
    }));
  }
}

/** One row past the page, so the last page knows it is last without trusting a count. */
const PAGE_READ = ACTIVITY_PAGE_SIZE + 1;

function pageOffset(page: number): number {
  return (page - 1) * ACTIVITY_PAGE_SIZE;
}

/**
 * A page read `PAGE_READ` rows deep, and what the footer can say about the rest. `counted` is
 * exact up to `cap` and one past it beyond. Reaching the end makes the total exact whatever was
 * counted, so the last page of a capped stream reads "1,001–1,025 of 1,025".
 */
function toPage<Row>(read: Row[], page: number, counted: number, cap: number): ActivityPage<Row> {
  const rows = read.slice(0, ACTIVITY_PAGE_SIZE);
  const hasNext = read.length > ACTIVITY_PAGE_SIZE;
  const reached = rows.length === 0 ? 0 : pageOffset(page) + rows.length;
  if (rows.length > 0 && !hasNext) return { rows, total: reached, totalCapped: false, hasNext };
  if (counted > cap) return { rows, total: Math.max(cap, reached), totalCapped: true, hasNext };
  return { rows, total: counted, totalCapped: false, hasNext };
}

/** Positional parameters, numbered as they are added. */
class Parameters {
  readonly values: unknown[];

  constructor(initial: unknown[]) {
    this.values = [...initial];
  }

  add(value: unknown): string {
    this.values.push(value);
    return `$${String(this.values.length)}`;
  }

  /** How many parameters precede a placeholder: a count query takes only the filter's. */
  countBefore(placeholder: string): number {
    return Number(placeholder.slice(1)) - 1;
  }
}

function runConditions(query: ActivityQuery, now: Date, params: Parameters): string {
  const conditions = ["runs.organization_id = $1"];
  const since = rangeStart(query.range, now);
  if (since !== null) conditions.push(`runs.created_at >= ${params.add(since)}`);
  if (query.providers.length > 0) {
    conditions.push(`receipts.provider = any(${params.add(query.providers)}::text[])`);
  }
  if (query.trigger !== null) conditions.push(`triggers.id = ${params.add(query.trigger)}::uuid`);
  if (query.statuses.length > 0) {
    conditions.push(`runs.status = any(${params.add(query.statuses)}::text[])`);
  }
  if (query.daemon !== null) {
    conditions.push(`exists (
      select 1 from workflow_step_runs steps
      join agent_executions executions on executions.id = steps.agent_execution_id
      where steps.trigger_run_id = runs.id and executions.daemon_id = ${params.add(query.daemon)}::uuid
    )`);
  }
  if (query.q !== null) {
    const pattern = params.add(containsPattern(query.q));
    conditions.push(`(
      coalesce(triggers.name, runs.configured_trigger_name) ilike ${pattern}
      or receipts.repo ilike ${pattern}
      or receipts.source ilike ${pattern}
      or receipts.delivery_id ilike ${pattern}
    )`);
  }
  return conditions.join(" and ");
}

function runOrder(query: ActivityQuery): string {
  const direction = query.dir === "asc" ? "asc" : "desc";
  const tiebreak = `runs.created_at ${direction}, runs.id ${direction}`;
  if (query.sort === "duration") return `${RUN_DURATION_MS} ${direction}, ${tiebreak}`;
  if (query.sort === "status") return `${STATUS_ORDER} ${direction}, ${tiebreak}`;
  return tiebreak;
}

function unmatchedConditions(query: ActivityQuery, now: Date, params: Parameters): string {
  const conditions = ["receipts.organization_id = $1", UNMATCHED_PREDICATE];
  const since = rangeStart(query.range, now);
  if (since !== null) conditions.push(`receipts.received_at >= ${params.add(since)}`);
  if (query.providers.length > 0) {
    conditions.push(`receipts.provider = any(${params.add(query.providers)}::text[])`);
  }
  if (query.reason !== null)
    conditions.push(`receipts.dropped_reason = ${params.add(query.reason)}`);
  if (query.q !== null) {
    const pattern = params.add(containsPattern(query.q));
    conditions.push(`(
      receipts.source ilike ${pattern}
      or receipts.repo ilike ${pattern}
      or receipts.delivery_id ilike ${pattern}
    )`);
  }
  conditions.push(`not exists (
    select 1 from trigger_runs runs where runs.provider_event_receipt_id = receipts.id
  )`);
  return conditions.join(" and ");
}

/** The reader's text matched anywhere, with its own `%` and `_` taken literally. */
function containsPattern(text: string): string {
  return `%${text.replaceAll(/[\\%_]/gu, (character) => `\\${character}`)}%`;
}

function toRun(row: RunRow): ActivityRun {
  return {
    id: row.id,
    triggerId: row.trigger_id,
    triggerName: row.trigger_name,
    provider: row.provider,
    source: row.source,
    repo: row.repo,
    status: row.status,
    receivedAt: row.received_at,
    durationMs: Math.max(0, Number(row.duration_ms)),
    daemon:
      row.daemon_id === null || row.daemon_slug === null
        ? null
        : { id: row.daemon_id, slug: row.daemon_slug },
    agent:
      row.agent_provider === null ? null : { provider: row.agent_provider, model: row.agent_model },
  };
}

function toUnmatched(row: UnmatchedRow): UnmatchedEvent {
  return {
    id: row.id,
    provider: row.provider,
    source: row.source,
    repo: row.repo,
    deliveryId: row.delivery_id,
    receivedAt: row.received_at,
    reason: row.dropped_reason,
  };
}

function toPayload(row: PayloadRow): PayloadPreview {
  return {
    bytes: row.payload_bytes,
    text: row.payload_preview,
    truncated: row.payload_truncated,
  };
}

interface StepRow extends Record<string, unknown> {
  id: string;
  step_id: string;
  ordinal: number;
  status: ActivityStep["status"];
  failure_reason: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  output_preview: string | null;
  output_truncated: boolean | null;
  execution_id: string | null;
  daemon_agent_id: string | null;
  agent_session_action: string | null;
  agent_provider: string | null;
  agent_model: string | null;
  daemon_id: string | null;
  daemon_slug: string | null;
}

function toStep(row: StepRow): ActivityStep {
  return {
    id: row.id,
    stepId: row.step_id,
    ordinal: row.ordinal,
    status: row.status,
    failureReason: row.failure_reason,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    output:
      row.output_preview === null
        ? null
        : { text: row.output_preview, truncated: row.output_truncated === true },
    execution:
      row.execution_id === null
        ? null
        : {
            id: row.execution_id,
            daemon:
              row.daemon_id === null || row.daemon_slug === null
                ? null
                : { id: row.daemon_id, slug: row.daemon_slug },
            agent:
              row.agent_provider === null
                ? null
                : { provider: row.agent_provider, model: row.agent_model },
            daemonAgentId: row.daemon_agent_id,
            sessionAction: row.agent_session_action,
          },
  };
}
