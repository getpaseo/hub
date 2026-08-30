import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, describe, it } from "vitest";
import { z } from "zod";
import { embeddedDatabaseRuntime } from "./runtime/index.js";

const roots: string[] = [];
const migrations = readMigrationFiles({ migrationsFolder: join(process.cwd(), "drizzle") });
const through0044 = migrations.slice(0, 45);
const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number(), tag: z.string() })),
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Forgejo 0045 foundation migration", () => {
  it("migrates an empty embedded database through 0045", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-forgejo-empty-"));
    roots.push(root);
    const bundle = await embeddedDatabaseRuntime(join(root, "database"));
    try {
      await bundle.runtime.migrate();
      const tables = await bundle.runtime.query<{ relname: string }>(
        `select relname from pg_class
         where relname like 'forgejo_%' and relkind = 'r'
         order by relname`,
      );
      assert.deepEqual(
        tables.rows.map((row) => row.relname),
        [
          "forgejo_connections",
          "forgejo_credentials",
          "forgejo_hydrated_events",
          "forgejo_hydration_cursors",
          "forgejo_instances",
          "forgejo_repositories",
          "forgejo_repository_hooks",
        ],
      );
      const counts = await bundle.runtime.query<{ n: number }>(
        `select count(*)::int as n from forgejo_instances`,
      );
      assert.equal(counts.rows[0]?.n, 0);
      const journal = journalSchema.parse(
        JSON.parse(await readFile(join(process.cwd(), "drizzle/meta/_journal.json"), "utf8")),
      );
      assert.equal(journal.entries.at(-1)?.idx, 45);
      assert.match(journal.entries.at(-1)?.tag ?? "", /^0045_/);
    } finally {
      await bundle.runtime.close();
    }
  });

  it("keeps representative Hub 0.8.0 rows unchanged after 0045", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-forgejo-compat-"));
    roots.push(root);
    const client = new PGlite(join(root, "database"));
    await client.waitReady;
    try {
      await client.exec(`create schema if not exists drizzle;
        create table drizzle.__drizzle_migrations (
          id serial primary key,
          hash text not null,
          created_at bigint
        );`);
      await client.transaction(async (transaction) => {
        for (const migration of through0044) {
          for (const statement of migration.sql) await transaction.exec(statement);
          await transaction.query(
            "insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)",
            [migration.hash, migration.folderMillis],
          );
        }
      });
      await seedRepresentative(client);
    } finally {
      await client.close();
    }

    const bundle = await embeddedDatabaseRuntime(join(root, "database"));
    try {
      await bundle.runtime.migrate();
      const github = await bundle.runtime.query<{ slug: string; installation_id: string }>(
        `select slug, installation_id::text as installation_id from github_connections`,
      );
      assert.deepEqual(github.rows, [{ slug: "compat-gh", installation_id: "9001" }]);
      const slack = await bundle.runtime.query<{ slug: string }>(
        `select slug from slack_connections`,
      );
      assert.equal(slack.rows[0]?.slug, "compat-slack");
      const discord = await bundle.runtime.query<{ slug: string }>(
        `select slug from discord_connections`,
      );
      assert.equal(discord.rows[0]?.slug, "compat-discord");
      const linear = await bundle.runtime.query<{ slug: string }>(
        `select slug from linear_connections`,
      );
      assert.equal(linear.rows[0]?.slug, "compat-linear");
      const receipts = await bundle.runtime.query<{ delivery_id: string; provider: string }>(
        `select delivery_id, provider from provider_event_receipts`,
      );
      assert.deepEqual(receipts.rows, [{ delivery_id: "compat-delivery-1", provider: "github" }]);
      const forgejo = await bundle.runtime.query<{ n: number }>(
        `select (select count(*)::int from forgejo_instances)
              + (select count(*)::int from forgejo_connections) as n`,
      );
      assert.equal(forgejo.rows[0]?.n, 0);
      const body = await bundle.runtime.query<{ body_sha256: string | null }>(
        `select body_sha256 from provider_event_receipts where delivery_id = 'compat-delivery-1'`,
      );
      assert.equal(body.rows[0]?.body_sha256, null);
    } finally {
      await bundle.runtime.close();
    }
  });
});

async function seedRepresentative(client: PGlite): Promise<void> {
  await client.exec(`
    insert into organization (id, name, slug) values ('org_t00_compat', 'Compat Org', 'compat-org');
    insert into "user" (id, name, email, email_verified)
      values ('user_t00_compat', 'Compat', 'compat@example.test', true);
    insert into github_connections
      (id, organization_id, installation_id, slug, account_id, account_login, account_type, status)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'org_t00_compat', 9001, 'compat-gh',
              '9001', 'compat-bot', 'Organization', 'active');
    insert into github_repositories
      (organization_id, connection_id, repository_id, full_name, default_branch)
      values ('org_t00_compat', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 4242, 'compat/widgets', 'main');
    insert into slack_connections
      (organization_id, team_id, slug, team_name, bot_user_id, bot_access_token, scopes)
      values ('org_t00_compat', 'T-compat', 'compat-slack', 'Compat Slack', 'U-bot', 'xoxb-compat', '[]'::jsonb);
    insert into discord_connections (organization_id, guild_id, slug, guild_name)
      values ('org_t00_compat', 'G-compat', 'compat-discord', 'Compat Discord');
    insert into linear_connections
      (organization_id, linear_organization_id, slug, linear_organization_name, app_user_id, access_token)
      values ('org_t00_compat', 'lin-compat', 'compat-linear', 'Compat Linear', 'lin-user', 'lin-token');
    insert into projects (id, organization_id, name, slug, status)
      values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'org_t00_compat', 'Compat Project',
              'compat-project', 'active');
    insert into project_configuration_sources
      (organization_id, project_id, kind, github_connection_id, github_repository_id,
       github_repository_full_name, github_default_branch, automatic_deployment_enabled)
      values ('org_t00_compat', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'github',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 4242, 'compat/widgets', 'main', false);
    insert into project_configuration_revisions
      (id, project_id, organization_id, version, source_kind, source_evidence, normalized_configuration,
       content_hash)
      values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              'org_t00_compat', 1, 'github', '{}'::jsonb, '{}'::jsonb, 'compat-hash');
    insert into provider_event_receipts
      (organization_id, provider, delivery_id, source, payload)
      values ('org_t00_compat', 'github', 'compat-delivery-1', 'github', '{}'::jsonb);
  `);
}
