import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
import { ReceiptRetention } from "./index.js";

describe("unhandled receipt retention", () => {
  let postgres: StartedPostgreSqlContainer;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);
  afterAll(async () => {
    await postgres?.stop();
  }, 120_000);

  it.each(["postgres", "embedded"])(
    "%s expires the backlog in bounded batches while preserving young, routed, and referenced receipts",
    async (driver) => {
      const directory = await mkdtemp(join(tmpdir(), "hub-retention-"));
      const { runtime } =
        driver === "postgres"
          ? await createPostgresTestRuntime(postgres.getConnectionUri())
          : await embeddedDatabaseRuntime(directory);
      await runtime.migrate();
      try {
        const fixture = `
        insert into organization (id, name, slug) values ('retention', 'Retention', 'retention');
        insert into provider_event_receipts
          (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason, accepted_routes)
        select 'retention', 'github', 'old-' || n, 'github.push', '{}',
          '2026-10-01T00:00:00Z', 'no_project_route',
          case when n % 2 = 0 then '[]'::jsonb else null end from generate_series(1, 1201) n;
        insert into provider_event_receipts
          (id, organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
        select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
          'retention', 'github', 'retained-' || n, 'github.push', '{}',
          '2026-10-26T00:00:00Z', 'no_project_route' from generate_series(1, 501) n;
        insert into provider_event_receipts
          (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason, accepted_routes)
        values
          ('retention', 'github', 'young', 'github.push', '{}', '2026-10-26T00:00:00Z', 'no_project_route', null),
          ('retention', 'github', 'boundary', 'github.push', '{}', '2026-10-20T00:00:00Z', 'no_project_route', null),
          ('retention', 'github', 'admitted-unhandled', 'github.push', '{}', '2026-10-01T00:00:00Z', 'no_trigger_for_source', '[{"projectId":"kept"}]'),
          ('retention', 'github', 'routed', 'github.push', '{}', '2026-10-01T00:00:00Z', null, '[{"projectId":"kept"}]'),
          ('retention', 'github', 'lifecycle', 'github.installation', '{}', '2026-10-01T00:00:00Z', 'github_lifecycle', null),
          ('retention', 'github', 'pending', 'github.push', '{}', '2026-10-01T00:00:00Z', null, null),
          ('retention', 'github', 'run', 'github.push', '{}', '2026-10-01T00:00:00Z', 'no_project_route', null),
          ('retention', 'slack', 'attachment', 'slack.message', '{}', '2026-10-01T00:00:00Z', 'no_project_route', null);
        insert into attachment_capabilities
          (provider_event_receipt_id, organization_id, connection_id, provider, source_id, locator, filename)
        select id, organization_id, gen_random_uuid(), 'slack', 'attachment', '{}', 'kept.txt'
        from provider_event_receipts where delivery_id = 'attachment';
        insert into projects (id, organization_id, name, slug)
        values ('10000000-0000-4000-8000-000000000001', 'retention', 'Retention', 'retention');
        insert into project_configuration_revisions
          (id, project_id, organization_id, version, source_kind, source_evidence, normalized_configuration, content_hash)
        values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'retention', 1, 'manual', '{}', '{}', 'retention');
        insert into trigger_runs
          (organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
           configured_trigger_name, status, prompt, deadline_at)
        select organization_id, '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001', id, 'kept', 'succeeded', '', now()
        from provider_event_receipts where delivery_id = 'run';
      `;
        for (const statement of fixture.split(";").filter((sql) => sql.trim())) {
          await runtime.query(statement);
        }
        const retention = new ReceiptRetention(runtime);
        let deleted = 0;
        let passes = 0;
        for (;;) {
          const batch = await retention.runBatch(new Date("2026-10-27T00:00:00Z"));
          assert.ok(batch.scanned <= 500);
          if (passes === 0) {
            assert.equal(batch.deleted, 0);
            assert.equal(batch.complete, false);
          }
          deleted += batch.deleted;
          passes++;
          if (batch.complete) break;
          assert.ok(passes < 10, "cleanup must advance beyond retained receipts");
        }
        assert.equal(deleted, 1202);
        assert.ok(passes >= 4);
        const remaining = await runtime.query<{ delivery_id: string }>(
          "select delivery_id from provider_event_receipts where delivery_id not like 'retained-%' order by delivery_id",
        );
        assert.deepEqual(
          remaining.rows.map((row) => row.delivery_id),
          ["attachment", "boundary", "lifecycle", "pending", "routed", "run", "young"],
        );
        // A later sweep revisits retained rows as they cross the seven-day boundary.
        let laterDeleted = 0;
        for (;;) {
          const later = await retention.runBatch(new Date("2026-10-28T00:00:00Z"));
          laterDeleted += later.deleted;
          if (later.complete) break;
        }
        assert.equal(laterDeleted, 1);
        await runtime.query(`insert into provider_event_receipts
        (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
        values ('retention', 'github', 'automatic', 'github.push', '{}',
          now() - interval '8 days', 'no_project_route')`);
        // Exercise the same automatic lifecycle used by the production composition.
        retention.start();
        retention.start();
        try {
          const deadline = Date.now() + 5000;
          for (;;) {
            const result = await runtime.query(
              "select id from provider_event_receipts where delivery_id = 'automatic'",
            );
            if (result.rowCount === 0) break;
            assert.ok(Date.now() < deadline, "automatic cleanup did not run");
            await delay(10);
          }
        } finally {
          await retention.stop();
        }
      } finally {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
