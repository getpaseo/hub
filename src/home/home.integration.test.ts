import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime, postgresDatabaseRuntime } from "../db/runtime/index.js";
import type { DatabaseRuntime } from "../db/runtime/index.js";
import { HomeDashboard } from "./dashboard.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const ORG = "home-org";
const DEPLOY = "30000000-0000-4000-8000-000000000001";
const request = new Request("https://hub.test/o/acme/home");

describe("home overview", () => {
  let postgres: StartedPostgreSqlContainer;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);
  afterAll(async () => {
    await postgres?.stop();
  }, 120_000);

  it.each(["postgres", "embedded"])(
    "%s counts every run in the range, not the first page of them",
    async (driver) => {
      const directory = await mkdtemp(join(tmpdir(), "hub-home-"));
      const bundle =
        driver === "postgres"
          ? await postgresDatabaseRuntime(postgres.getConnectionUri())
          : await embeddedDatabaseRuntime(directory);
      try {
        await bundle.runtime.migrate();
        await seed(bundle.runtime);
        const home = new HomeDashboard(
          createDatabase(bundle.runtime, bundle.locks),
          accountAuth(),
          () => true,
          () => NOW,
        );

        // 60 runs arrived in the last day. Home used to read the newest 50 and count those.
        const day = await home.snapshot(request, "acme", "24h");
        expect(day.range).toBe("24h");
        expect(day.runs).toEqual({
          running: 2,
          succeeded: 53,
          failed: 4,
          timed_out: 1,
          rejected: 0,
        });
        expect(day.busiestTriggers).toEqual([
          {
            id: DEPLOY,
            name: "deploy",
            provider: "manual",
            event: "Manual run",
            runs: 60,
            failed: 5,
            lastRunAt: "2026-11-20T11:40:00.000Z",
          },
        ]);
        expect(day.daemons.map(({ slug, runs }) => ({ slug, runs }))).toEqual([
          { slug: "devbox", runs: 55 },
        ]);
        expect(day.latestRun).toEqual({
          triggerName: "deploy",
          receivedAt: "2026-11-20T11:40:00.000Z",
        });

        // The week also holds the failed run from three days ago.
        const week = await home.snapshot(request, "acme", "7d");
        expect(week.runs).toEqual({
          running: 2,
          succeeded: 53,
          failed: 5,
          timed_out: 1,
          rejected: 0,
        });
        expect(week.busiestTriggers.map(({ runs, failed }) => ({ runs, failed }))).toEqual([
          { runs: 61, failed: 6 },
        ]);
      } finally {
        await bundle.runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

/**
 * One organization with one trigger that ran 60 times in the last day, and once three days
 * before that, on a daemon that ran the most recent 55 of them.
 */
async function seed(runtime: DatabaseRuntime) {
  const statements = `insert into "user" (id, name, email) values ('user-1', 'User', 'user@example.test');
     insert into organization (id, name, slug) values ('${ORG}', 'Acme', 'acme');
     insert into member (id, organization_id, user_id, role) values ('membership-1', '${ORG}', 'user-1', 'owner');
     insert into projects (id, organization_id, name, slug) values
       ('10000000-0000-4000-8000-000000000001', '${ORG}', 'Deploy', 'deploy');
     insert into project_configuration_revisions
       (id, project_id, organization_id, version, source_kind, source_evidence, normalized_configuration, content_hash)
     values
       ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '${ORG}', 1, 'manual', '{}', '{}', 'deploy');
     insert into organization_triggers (id, organization_id, name, format, runtime_project_id) values
       ('${DEPLOY}', '${ORG}', 'deploy', 'single_run', '10000000-0000-4000-8000-000000000001');
     insert into machines (id, org_id, source, status) values
       ('60000000-0000-4000-8000-000000000001', '${ORG}', '{"kind":"daemon","daemonId":"60000000-0000-4000-8000-000000000002"}', 'alive');
     insert into daemons
       (id, idempotency_key, enrollment_verifier, slug, machine_id, organization_id,
        server_id, daemon_public_key, credential_verifier, scopes, status)
     values
       ('60000000-0000-4000-8000-000000000002', 'home-enrollment', 'home-verifier', 'devbox',
        '60000000-0000-4000-8000-000000000001', '${ORG}', 'home-server', 'key', 'credential',
        '["hub.execute"]', 'active');
     insert into provider_event_receipts
       (id, organization_id, provider, delivery_id, source, payload, received_at)
     select ('50000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '${ORG}', 'github',
       'deploy-' || n, 'github.push', '{}'::jsonb,
       '2026-11-20T12:00:00Z'::timestamptz - n * interval '20 minutes'
     from generate_series(1, 60) n;
     insert into provider_event_receipts
       (id, organization_id, provider, delivery_id, source, payload, received_at)
     values ('50000000-0000-4000-8000-000000000999', '${ORG}', 'github', 'deploy-old', 'github.push',
       '{}', '2026-11-17T12:00:00Z');
     insert into trigger_runs
       (id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
        configured_trigger_name, status, prompt, deadline_at, created_at, completed_at)
     select ('80000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '${ORG}',
       '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
       ('50000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'deploy',
       case when n <= 2 then 'running' when n <= 6 then 'failed' when n = 7 then 'timed_out' else 'succeeded' end,
       'prompt', '2026-12-01T00:00:00Z',
       '2026-11-20T12:00:00Z'::timestamptz - n * interval '20 minutes',
       case when n <= 2 then null else '2026-11-20T12:00:00Z'::timestamptz - n * interval '20 minutes' + interval '1 minute' end
     from generate_series(1, 60) n;
     insert into trigger_runs
       (id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
        configured_trigger_name, status, prompt, deadline_at, created_at, completed_at)
     values ('80000000-0000-4000-8000-000000000999', '${ORG}', '10000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000999', 'deploy',
       'failed', 'prompt', '2026-12-01T00:00:00Z', '2026-11-17T12:00:00Z', '2026-11-17T12:01:00Z');
     insert into agent_executions
       (id, organization_id, project_id, status, configuration_revision_id, daemon_id, launch_intent)
     select ('70000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '${ORG}',
       '10000000-0000-4000-8000-000000000001', 'succeeded', '20000000-0000-4000-8000-000000000001',
       '60000000-0000-4000-8000-000000000002', '{"agent":{"provider":"codex","model":"gpt-5.4"}}'
     from generate_series(1, 55) n;
     insert into workflow_step_runs (trigger_run_id, step_id, ordinal, status, agent_execution_id)
     select ('80000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'run', 0, 'succeeded',
       ('70000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
     from generate_series(1, 55) n;`;
  for (const statement of statements.split(";").filter((sql) => sql.trim() !== "")) {
    await runtime.query(statement);
  }
}

function accountAuth(): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: ORG },
        account: { id: "user-1", name: "User", email: "user@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
