import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embeddedDatabaseRuntime, type DatabaseRuntime } from "../db/runtime/index.js";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
import { ActivityRepository } from "./index.js";
import { activityQuery, parseActivitySearch } from "./query-contract.js";
import { PAYLOAD_PREVIEW_CHARACTERS } from "./store.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const ORG = "activity-org";
const OTHER_ORG = "other-org";
const DEPLOY = "30000000-0000-4000-8000-000000000001";
const TRIAGE = "30000000-0000-4000-8000-000000000002";
const DAEMON = "60000000-0000-4000-8000-000000000002";
const EXECUTION = "70000000-0000-4000-8000-000000000001";
const TRIAGE_RUN = "80000000-0000-4000-8000-000000000001";
const OTHER_RUN = "80000000-0000-4000-8000-000000000002";
const ROUTED_DROP = "90000000-0000-4000-8000-000000000001";
const LARGE_DROP = "90000000-0000-4000-8000-000000000002";

/** Columns that hold webhook bodies, prompts, and run contexts. Lists never name them. */
const PAYLOAD_COLUMNS =
  /\b(payload|accepted_routes|prompt|inputs|values|trigger_context|output_context|output|conversation)\b/iu;
const PRIVATE = "PRIVATE-PAYLOAD-MARKER";

describe("activity store", () => {
  let postgres: StartedPostgreSqlContainer;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);
  afterAll(async () => {
    await postgres?.stop();
  }, 120_000);

  it.each(["postgres", "embedded"])(
    "%s lists, filters, sorts, pages, and opens runs and unmatched events without reading payloads in lists",
    async (driver) => {
      const directory = await mkdtemp(join(tmpdir(), "hub-activity-"));
      const { runtime } =
        driver === "postgres"
          ? await createPostgresTestRuntime(postgres.getConnectionUri())
          : await embeddedDatabaseRuntime(directory);
      try {
        await runtime.migrate();
        await seed(runtime);
        const statements: string[] = [];
        const activity = new ActivityRepository({
          query: (sql, params) => {
            statements.push(sql);
            return runtime.query(sql, params);
          },
        });
        const query = (search: Record<string, unknown> = {}) =>
          activityQuery(parseActivitySearch(search));

        // Runs: the default window is the last 7 days, newest first, 25 to a page.
        const runs = await activity.listRuns(ORG, query(), NOW);
        expect(runs.total).toBe(61);
        expect(runs.totalCapped).toBe(false);
        expect(runs.rows).toHaveLength(25);
        expect(runs.rows[0]).toMatchObject({
          triggerName: "deploy",
          triggerId: DEPLOY,
          provider: "github",
          source: "github.push",
          status: "running",
          daemon: null,
          agent: null,
        });
        expect(isSorted(runs.rows.map((run) => -run.receivedAt.getTime()))).toBe(true);
        expect((await activity.listRuns(ORG, query({ page: "3" }), NOW)).rows).toHaveLength(11);
        expect((await activity.listRuns(ORG, query({ range: "24h" }), NOW)).total).toBe(60);
        expect((await activity.listRuns(ORG, query({ range: "all" }), NOW)).total).toBe(62);

        const triage = await activity.listRuns(ORG, query({ trigger: TRIAGE }), NOW);
        expect(triage.rows).toEqual([
          expect.objectContaining({
            id: TRIAGE_RUN,
            triggerName: "triage",
            repo: "getpaseo/hub",
            status: "failed",
            durationMs: 90_000,
            daemon: { id: DAEMON, slug: "devbox" },
            agent: { provider: "claude", model: "opus" },
          }),
        ]);
        expect((await activity.listRuns(ORG, query({ daemon: DAEMON }), NOW)).total).toBe(1);
        expect(
          (await activity.listRuns(ORG, query({ status: "failed,timed_out,rejected" }), NOW)).total,
        ).toBe(21);
        expect((await activity.listRuns(ORG, query({ provider: "slack" }), NOW)).total).toBe(0);
        expect((await activity.listRuns(ORG, query({ q: "PASEO/HUB" }), NOW)).total).toBe(1);
        expect((await activity.listRuns(ORG, query({ q: "%" }), NOW)).total).toBe(0);

        const byDuration = await activity.listRuns(
          ORG,
          query({ sort: "duration", dir: "asc" }),
          NOW,
        );
        expect(isSorted(byDuration.rows.map((run) => run.durationMs))).toBe(true);
        const byStatus = await activity.listRuns(ORG, query({ sort: "status", range: "all" }), NOW);
        expect(byStatus.rows.slice(0, 3).map((run) => run.status)).toEqual([
          "running",
          "running",
          "running",
        ]);
        expect(byStatus.rows.find((run) => run.status !== "running")?.status).toBe("failed");

        // Unmatched events: dropped receipts that never became a run, in the reader's window.
        const unmatched = await activity.listUnmatched(ORG, query({ view: "unmatched" }), NOW);
        expect(unmatched).toMatchObject({ total: 33, totalCapped: false });
        expect(unmatched.rows).toHaveLength(25);
        expect(unmatched.rows.map((event) => event.id)).not.toContain(ROUTED_DROP);
        expect(isSorted(unmatched.rows.map((event) => -event.receivedAt.getTime()))).toBe(true);
        expect(
          (await activity.listUnmatched(ORG, query({ view: "unmatched", provider: "slack" }), NOW))
            .total,
        ).toBe(2);
        expect(
          (
            await activity.listUnmatched(
              ORG,
              query({ view: "unmatched", reason: "trigger_filters_rejected" }),
              NOW,
            )
          ).rows.map((event) => event.reason),
        ).toEqual(["trigger_filters_rejected", "trigger_filters_rejected"]);
        expect(
          (await activity.listUnmatched(ORG, query({ view: "unmatched", range: "all" }), NOW))
            .total,
        ).toBe(34);

        expect(await activity.filterOptions(ORG)).toEqual({
          triggers: [
            { id: DEPLOY, name: "deploy" },
            { id: TRIAGE, name: "triage" },
          ],
          daemons: [{ id: DAEMON, slug: "devbox" }],
        });

        // The overview counts every run in its window, in the terms the list filters by.
        const day = await activity.summarize(ORG, new Date(NOW.getTime() - 86_400_000), 8);
        expect(day).toEqual({
          statuses: { running: 20, succeeded: 20, failed: 20, timed_out: 0, rejected: 0 },
          triggers: [
            {
              id: DEPLOY,
              name: "deploy",
              runs: 60,
              failed: 20,
              lastRunAt: new Date("2026-11-20T11:40:00Z"),
            },
            { id: TRIAGE, name: "triage", runs: 0, failed: 0, lastRunAt: null },
          ],
          daemons: [],
        });
        const week = await activity.summarize(ORG, new Date(NOW.getTime() - 7 * 86_400_000), 1);
        expect(week.triggers.map((trigger) => trigger.name)).toEqual(["deploy"]);
        expect(week.daemons).toEqual([{ id: DAEMON, runs: 1 }]);
        expect(Object.values(week.statuses).reduce((sum, count) => sum + count, 0)).toBe(
          (await activity.listRuns(ORG, query(), NOW)).total,
        );
        expect(
          await activity.summarizeProviders(ORG, new Date(NOW.getTime() - 7 * 86_400_000)),
        ).toEqual([{ provider: "github", runs: 61, failed: 21 }]);
        expect(await activity.lastRuns(ORG)).toEqual([
          { triggerId: DEPLOY, status: "running", receivedAt: new Date("2026-11-20T11:40:00Z") },
          { triggerId: TRIAGE, status: "failed", receivedAt: new Date("2026-11-17T12:00:00Z") },
        ]);
        expect(await activity.latestRun(ORG)).toEqual({
          triggerName: "deploy",
          receivedAt: new Date("2026-11-20T11:40:00Z"),
        });
        expect(await activity.latestRun(OTHER_ORG)).toEqual({
          triggerName: "other",
          receivedAt: new Date("2026-11-19T00:00:00Z"),
        });

        // No list, filter, or overview query names a payload column, and no list result carries one.
        expect(statements.filter((sql) => PAYLOAD_COLUMNS.test(sql))).toEqual([]);
        expect(JSON.stringify([runs, triage, unmatched])).not.toContain(PRIVATE);

        // Opening one record reads its payload, capped for the drawer.
        const run = await activity.findRun(ORG, TRIAGE_RUN, NOW);
        expect(run).toMatchObject({
          id: TRIAGE_RUN,
          deliveryId: "triage-delivery",
          outcome: "accepted",
          failureReason: "agent crashed",
          rejection: null,
          steps: [
            {
              stepId: "triage",
              status: "failed",
              output: null,
              execution: {
                id: EXECUTION,
                daemon: { id: DAEMON, slug: "devbox" },
                agent: { provider: "claude", model: "opus" },
                daemonAgentId: "agent-1",
              },
            },
          ],
        });
        expect(run?.payload.text).toContain(PRIVATE);
        expect(run?.payload.truncated).toBe(false);
        expect(run?.prompt).toContain("PRIVATE-PROMPT");
        expect(await activity.findRun(ORG, OTHER_RUN, NOW)).toBeUndefined();

        const large = await activity.findUnmatched(ORG, LARGE_DROP);
        expect(large).toMatchObject({
          provider: "github",
          connectionSlug: "acme-github",
          reason: "no_trigger_for_source",
          payload: { truncated: true },
        });
        expect(large?.payload.text).toHaveLength(PAYLOAD_PREVIEW_CHARACTERS);
        expect(large?.payload.bytes).toBeGreaterThan(70_000);
        expect(await activity.findUnmatched(ORG, ROUTED_DROP)).toBeUndefined();
        expect(await activity.findUnmatched(OTHER_ORG, LARGE_DROP)).toBeUndefined();

        expect(await activity.findRunIdForExecution(EXECUTION)).toBe(TRIAGE_RUN);

        // A noisy stream is counted only up to the cap.
        await runtime.query(
          `insert into provider_event_receipts
             (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
           select $1, 'github', 'flood-' || n, 'github.push', '{}', $2::timestamptz - n * interval '1 second',
             'no_project_route'
           from generate_series(1, 1000) n`,
          [ORG, NOW],
        );
        expect(await activity.listUnmatched(ORG, query({ view: "unmatched" }), NOW)).toMatchObject({
          total: 1_000,
          totalCapped: true,
        });
      } finally {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.each(["postgres", "embedded"])(
    "%s attributes a migrated trigger's runs from before the migration to it",
    async (driver) => {
      const directory = await mkdtemp(join(tmpdir(), "hub-activity-migrated-"));
      const { runtime } =
        driver === "postgres"
          ? await createPostgresTestRuntime(postgres.getConnectionUri())
          : await embeddedDatabaseRuntime(directory);
      try {
        await runtime.migrate();
        await seedMigratedTrigger(runtime);
        const activity = new ActivityRepository(runtime);
        const query = (search: Record<string, unknown> = {}) =>
          activityQuery(parseActivitySearch(search));

        // The legacy project's `review` run is the trigger's; its `lint` run, from a workflow
        // that became another trigger, is not.
        const runs = await activity.listRuns(
          MIGRATED_ORG,
          query({ trigger: REVIEW, range: "all" }),
          NOW,
        );
        expect(runs.rows.map((run) => [run.id, run.triggerId, run.triggerName])).toEqual([
          [CURRENT_REVIEW_RUN, REVIEW, "legacy-review"],
          [LEGACY_REVIEW_RUN, REVIEW, "legacy-review"],
        ]);
        expect(await activity.findRun(MIGRATED_ORG, LEGACY_REVIEW_RUN, NOW)).toMatchObject({
          triggerId: REVIEW,
          triggerName: "legacy-review",
        });
        expect(await activity.findRun(MIGRATED_ORG, LEGACY_LINT_RUN, NOW)).toMatchObject({
          triggerId: null,
          triggerName: "lint",
        });

        const summary = await activity.summarize(MIGRATED_ORG, new Date(0), 8);
        expect(summary.triggers).toEqual([
          {
            id: REVIEW,
            name: "legacy-review",
            runs: 2,
            failed: 1,
            lastRunAt: new Date("2026-11-19T00:00:00Z"),
          },
        ]);
        expect(await activity.lastRuns(MIGRATED_ORG)).toEqual([
          { triggerId: REVIEW, status: "succeeded", receivedAt: new Date("2026-11-19T00:00:00Z") },
        ]);
      } finally {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

const MIGRATED_ORG = "migrated-org";
const LEGACY_PROJECT = "11000000-0000-4000-8000-000000000001";
const REVIEW_RUNTIME = "11000000-0000-4000-8000-000000000002";
const REVIEW = "31000000-0000-4000-8000-000000000001";
const LEGACY_REVIEW_RUN = "81000000-0000-4000-8000-000000000001";
const LEGACY_LINT_RUN = "81000000-0000-4000-8000-000000000002";
const CURRENT_REVIEW_RUN = "81000000-0000-4000-8000-000000000003";

/**
 * A project migrated into one trigger, `review`, renamed `legacy-review` because the name was
 * taken. Its runs from before the migration stay in the legacy project.
 */
async function seedMigratedTrigger(runtime: DatabaseRuntime) {
  const statements = `
    insert into organization (id, name, slug) values ('${MIGRATED_ORG}', 'Migrated', 'migrated');
    insert into projects (id, organization_id, name, slug) values
      ('${LEGACY_PROJECT}', '${MIGRATED_ORG}', 'Legacy', 'legacy'),
      ('${REVIEW_RUNTIME}', '${MIGRATED_ORG}', 'Trigger runtime: legacy-review', 'trigger-review');
    insert into project_configuration_revisions
      (id, project_id, organization_id, version, source_kind, source_evidence, normalized_configuration, content_hash)
    values
      ('21000000-0000-4000-8000-000000000001', '${LEGACY_PROJECT}', '${MIGRATED_ORG}', 1, 'manual', '{}', '{}', 'legacy'),
      ('21000000-0000-4000-8000-000000000002', '${REVIEW_RUNTIME}', '${MIGRATED_ORG}', 1, 'manual', '{}', '{}', 'review');
    insert into organization_triggers (id, organization_id, name, format, runtime_project_id) values
      ('${REVIEW}', '${MIGRATED_ORG}', 'legacy-review', 'single_run', '${REVIEW_RUNTIME}');
    insert into organization_trigger_revisions
      (trigger_id, organization_id, version, yaml, normalized_configuration, content_hash,
       source_kind, source_evidence)
    values
      ('${REVIEW}', '${MIGRATED_ORG}', 1, '', '{"environments":[],"triggers":[{"name":"review"}]}',
       'review', 'project_migration',
       '{"kind":"project_migration","legacyProjectId":"${LEGACY_PROJECT}"}');
    insert into provider_event_receipts
      (id, organization_id, provider, delivery_id, source, payload, received_at)
    values
      ('53000000-0000-4000-8000-000000000001', '${MIGRATED_ORG}', 'github', 'legacy-review',
       'github.pull_request', '{}', '2026-11-01T00:00:00Z'),
      ('53000000-0000-4000-8000-000000000002', '${MIGRATED_ORG}', 'github', 'legacy-lint',
       'github.pull_request', '{}', '2026-11-02T00:00:00Z'),
      ('53000000-0000-4000-8000-000000000003', '${MIGRATED_ORG}', 'github', 'current-review',
       'github.pull_request', '{}', '2026-11-19T00:00:00Z');
    insert into trigger_runs
      (id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
       configured_trigger_name, status, prompt, deadline_at, created_at)
    values
      ('${LEGACY_REVIEW_RUN}', '${MIGRATED_ORG}', '${LEGACY_PROJECT}', '21000000-0000-4000-8000-000000000001',
       '53000000-0000-4000-8000-000000000001', 'review', 'failed', '', '2026-12-01T00:00:00Z',
       '2026-11-01T00:00:00Z'),
      ('${LEGACY_LINT_RUN}', '${MIGRATED_ORG}', '${LEGACY_PROJECT}', '21000000-0000-4000-8000-000000000001',
       '53000000-0000-4000-8000-000000000002', 'lint', 'succeeded', '', '2026-12-01T00:00:00Z',
       '2026-11-02T00:00:00Z'),
      ('${CURRENT_REVIEW_RUN}', '${MIGRATED_ORG}', '${REVIEW_RUNTIME}', '21000000-0000-4000-8000-000000000002',
       '53000000-0000-4000-8000-000000000003', 'legacy-review', 'succeeded', '', '2026-12-01T00:00:00Z',
       '2026-11-19T00:00:00Z')
  `;
  for (const statement of statements.split(";").filter((sql) => sql.trim() !== "")) {
    await runtime.query(statement);
  }
}

function isSorted(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! <= value);
}

/**
 * One organization with two triggers, sixty recent deploy runs, a three-day-old triage run that
 * reached a daemon, a stream of dropped events, and a second organization nothing may leak from.
 */
async function seed(runtime: DatabaseRuntime) {
  const statements = `
    insert into organization (id, name, slug) values
      ('${ORG}', 'Activity', 'activity'), ('${OTHER_ORG}', 'Other', 'other');
    insert into projects (id, organization_id, name, slug) values
      ('10000000-0000-4000-8000-000000000001', '${ORG}', 'Deploy', 'deploy'),
      ('10000000-0000-4000-8000-000000000002', '${ORG}', 'Triage', 'triage'),
      ('10000000-0000-4000-8000-000000000003', '${OTHER_ORG}', 'Other', 'other');
    insert into project_configuration_revisions
      (id, project_id, organization_id, version, source_kind, source_evidence, normalized_configuration, content_hash)
    values
      ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '${ORG}', 1, 'manual', '{}', '{}', 'deploy'),
      ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '${ORG}', 1, 'manual', '{}', '{}', 'triage'),
      ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', '${OTHER_ORG}', 1, 'manual', '{}', '{}', 'other');
    insert into organization_triggers (id, organization_id, name, format, runtime_project_id) values
      ('${DEPLOY}', '${ORG}', 'deploy', 'single_run', '10000000-0000-4000-8000-000000000001'),
      ('${TRIAGE}', '${ORG}', 'triage', 'single_run', '10000000-0000-4000-8000-000000000002');
    insert into github_connections
      (id, organization_id, installation_id, slug, account_id, account_login, account_type, status)
    values
      ('40000000-0000-4000-8000-000000000001', '${ORG}', 970001, 'acme-github', 'acme', 'acme', 'Organization', 'active');
    insert into machines (id, org_id, source, status) values
      ('60000000-0000-4000-8000-000000000001', '${ORG}', '{"kind":"daemon","daemonId":"${DAEMON}"}', 'alive');
    insert into daemons
      (id, idempotency_key, enrollment_verifier, slug, machine_id, organization_id,
       server_id, daemon_public_key, credential_verifier, scopes, status)
    values
      ('${DAEMON}', 'activity-enrollment', 'activity-verifier', 'devbox',
       '60000000-0000-4000-8000-000000000001', '${ORG}', 'activity-server', 'key', 'credential',
       '["hub.execute"]', 'active');

    insert into provider_event_receipts
      (id, organization_id, provider, delivery_id, source, repo, payload, received_at)
    select ('50000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '${ORG}', 'github',
      'deploy-' || n, 'github.push', 'getpaseo/app',
      jsonb_build_object('secret', '${PRIVATE}'),
      '2026-11-20T12:00:00Z'::timestamptz - n * interval '20 minutes'
    from generate_series(1, 60) n;
    insert into trigger_runs
      (organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
       configured_trigger_name, status, prompt, deadline_at, created_at, completed_at)
    select '${ORG}', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
      ('50000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'deploy',
      case when n % 3 = 1 then 'running' when n % 3 = 2 then 'succeeded' else 'failed' end,
      'PRIVATE-PROMPT', '2026-12-01T00:00:00Z',
      '2026-11-20T12:00:00Z'::timestamptz - n * interval '20 minutes',
      case when n % 3 = 1 then null
        else '2026-11-20T12:00:00Z'::timestamptz - n * interval '20 minutes' + n * interval '1 second' end
    from generate_series(1, 60) n;

    insert into provider_event_receipts
      (id, organization_id, provider, delivery_id, source, repo, payload, received_at)
    values
      ('51000000-0000-4000-8000-000000000001', '${ORG}', 'github', 'triage-delivery', 'github.issues',
       'getpaseo/hub', '{"secret":"${PRIVATE}"}', '2026-11-17T12:00:00Z');
    insert into trigger_runs
      (id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
       configured_trigger_name, status, prompt, deadline_at, failure_reason, created_at, completed_at)
    values
      ('${TRIAGE_RUN}', '${ORG}', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002',
       '51000000-0000-4000-8000-000000000001', 'triage', 'failed', 'PRIVATE-PROMPT', '2026-12-01T00:00:00Z',
       'agent crashed', '2026-11-17T12:00:00Z', '2026-11-17T12:01:30Z');
    insert into agent_executions
      (id, organization_id, project_id, status, configuration_revision_id, daemon_id, daemon_agent_id, launch_intent)
    values
      ('${EXECUTION}', '${ORG}', '10000000-0000-4000-8000-000000000002', 'failed',
       '20000000-0000-4000-8000-000000000002', '${DAEMON}', 'agent-1',
       '{"agent":{"provider":"claude","model":"opus"}}');
    insert into workflow_step_runs (trigger_run_id, step_id, ordinal, status, agent_execution_id, failure_reason)
    values ('${TRIAGE_RUN}', 'triage', 0, 'failed', '${EXECUTION}', 'agent crashed');

    insert into provider_event_receipts
      (organization_id, provider, delivery_id, source, repo, payload, received_at, dropped_reason)
    select '${ORG}', 'github', 'dropped-' || n, 'github.pull_request', 'getpaseo/docs',
      jsonb_build_object('secret', '${PRIVATE}'),
      '2026-11-20T12:00:00Z'::timestamptz - n * interval '1 hour', 'no_trigger_for_source'
    from generate_series(1, 30) n;
    insert into provider_event_receipts
      (id, organization_id, provider, connection_id, delivery_id, source, payload, received_at, dropped_reason)
    values
      ('${LARGE_DROP}', '${ORG}', 'github', '40000000-0000-4000-8000-000000000001', 'large',
       'github.push', jsonb_build_object('body', repeat('x', 70000)), '2026-11-19T00:00:00Z',
       'no_trigger_for_source'),
      ('${ROUTED_DROP}', '${ORG}', 'github', null, 'routed-drop', 'github.push', '{}',
       '2026-11-19T00:00:00Z', 'no_trigger_for_source'),
      (gen_random_uuid(), '${ORG}', 'slack', null, 'slack-1', 'slack.app_mention', '{}',
       '2026-11-19T00:00:00Z', 'trigger_filters_rejected'),
      (gen_random_uuid(), '${ORG}', 'slack', null, 'slack-2', 'slack.app_mention', '{}',
       '2026-11-19T01:00:00Z', 'trigger_filters_rejected'),
      (gen_random_uuid(), '${ORG}', 'github', null, 'lifecycle', 'github.installation', '{}',
       '2026-11-19T00:00:00Z', 'github_lifecycle'),
      (gen_random_uuid(), '${ORG}', 'github', null, 'old', 'github.push', '{}',
       '2026-10-01T00:00:00Z', 'no_project_route'),
      ('52000000-0000-4000-8000-000000000001', '${OTHER_ORG}', 'github', null, 'other', 'github.push', '{}',
       '2026-11-19T00:00:00Z', null),
      (gen_random_uuid(), '${OTHER_ORG}', 'github', null, 'other-drop', 'github.push', '{}',
       '2026-11-19T00:00:00Z', 'no_project_route');
    insert into trigger_runs
      (organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
       configured_trigger_name, status, prompt, deadline_at, created_at)
    values
      ('${ORG}', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
       '${ROUTED_DROP}', 'deploy', 'succeeded', '', '2026-12-01T00:00:00Z', '2026-10-01T00:00:00Z');
    insert into trigger_runs
      (id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
       configured_trigger_name, status, prompt, deadline_at, created_at)
    values
      ('${OTHER_RUN}', '${OTHER_ORG}', '10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003',
       '52000000-0000-4000-8000-000000000001', 'other', 'running', '', '2026-12-01T00:00:00Z', '2026-11-19T00:00:00Z')
  `;
  for (const statement of statements.split(";").filter((sql) => sql.trim() !== "")) {
    await runtime.query(statement);
  }
}
