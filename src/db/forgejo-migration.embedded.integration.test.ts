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

describe("Forgejo 0045-0046 foundation migration", () => {
  it("migrates an empty embedded database through 0046", async () => {
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
          "forgejo_recovery_work",
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
      assert.equal(journal.entries.at(-1)?.idx, 46);
      assert.match(journal.entries.at(-1)?.tag ?? "", /^0046_/);
    } finally {
      await bundle.runtime.close();
    }
  });

  it("keeps representative Hub 0.8.0 rows unchanged after 0046", async () => {
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
      const applied = await bundle.runtime.query<{ n: number }>(
        `select count(*)::int as n from drizzle.__drizzle_migrations`,
      );
      assert.equal(applied.rows[0]?.n, migrations.length);

      const github = await bundle.runtime.query<{
        slug: string;
        installation_id: string;
        account_login: string;
        account_type: string;
        status: string;
      }>(
        `select slug, installation_id::text as installation_id, account_login, account_type, status
         from github_connections`,
      );
      assert.deepEqual(github.rows, [
        {
          slug: "compat-gh",
          installation_id: "9001",
          account_login: "compat-bot",
          account_type: "Organization",
          status: "active",
        },
      ]);
      const githubRepositories = await bundle.runtime.query<{
        repository_id: string;
        full_name: string;
        default_branch: string;
      }>(
        `select repository_id::text as repository_id, full_name, default_branch
         from github_repositories`,
      );
      assert.deepEqual(githubRepositories.rows, [
        { repository_id: "4242", full_name: "compat/widgets", default_branch: "main" },
      ]);
      const slack = await bundle.runtime.query<{ slug: string; team_name: string }>(
        `select slug, team_name from slack_connections`,
      );
      assert.deepEqual(slack.rows, [{ slug: "compat-slack", team_name: "Compat Slack" }]);
      const discord = await bundle.runtime.query<{ slug: string; guild_name: string }>(
        `select slug, guild_name from discord_connections`,
      );
      assert.deepEqual(discord.rows, [{ slug: "compat-discord", guild_name: "Compat Discord" }]);
      const linear = await bundle.runtime.query<{
        slug: string;
        linear_organization_name: string;
      }>(`select slug, linear_organization_name from linear_connections`);
      assert.deepEqual(linear.rows, [
        { slug: "compat-linear", linear_organization_name: "Compat Linear" },
      ]);
      const projects = await bundle.runtime.query<{
        slug: string;
        name: string;
        status: string;
      }>(`select slug, name, status from projects order by slug`);
      assert.deepEqual(projects.rows, [
        { slug: "compat-manual-project", name: "Compat Manual Project", status: "active" },
        { slug: "compat-project", name: "Compat Project", status: "active" },
      ]);
      const sources = await bundle.runtime.query<{
        project_slug: string;
        kind: string;
        github_connection_id: string | null;
        github_repository_id: string | null;
        github_repository_full_name: string | null;
        github_default_branch: string | null;
        forgejo_connection_id: string | null;
        forgejo_repository_id: string | null;
        automatic_deployment_enabled: boolean;
      }>(
        `select projects.slug as project_slug, project_configuration_sources.kind,
                project_configuration_sources.github_connection_id,
                project_configuration_sources.github_repository_id::text,
                project_configuration_sources.github_repository_full_name,
                project_configuration_sources.github_default_branch,
                project_configuration_sources.forgejo_connection_id,
                project_configuration_sources.forgejo_repository_id::text,
                project_configuration_sources.automatic_deployment_enabled
         from project_configuration_sources
         join projects on projects.id = project_configuration_sources.project_id
         order by projects.slug`,
      );
      assert.deepEqual(sources.rows, [
        {
          project_slug: "compat-manual-project",
          kind: "manual",
          github_connection_id: null,
          github_repository_id: null,
          github_repository_full_name: null,
          github_default_branch: null,
          forgejo_connection_id: null,
          forgejo_repository_id: null,
          automatic_deployment_enabled: false,
        },
        {
          project_slug: "compat-project",
          kind: "github",
          github_connection_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          github_repository_id: "4242",
          github_repository_full_name: "compat/widgets",
          github_default_branch: "main",
          forgejo_connection_id: null,
          forgejo_repository_id: null,
          automatic_deployment_enabled: false,
        },
      ]);
      const revisions = await bundle.runtime.query<{
        project_slug: string;
        version: number;
        source_kind: string;
        content_hash: string;
      }>(
        `select projects.slug as project_slug, project_configuration_revisions.version,
                project_configuration_revisions.source_kind,
                project_configuration_revisions.content_hash
         from project_configuration_revisions
         join projects on projects.id = project_configuration_revisions.project_id
         order by projects.slug, project_configuration_revisions.version`,
      );
      assert.deepEqual(revisions.rows, [
        {
          project_slug: "compat-manual-project",
          version: 1,
          source_kind: "manual",
          content_hash: "compat-manual-hash",
        },
        {
          project_slug: "compat-project",
          version: 1,
          source_kind: "github",
          content_hash: "compat-hash",
        },
      ]);
      const receipts = await bundle.runtime.query<{
        delivery_id: string;
        provider: string;
        source: string;
        body_sha256: string | null;
      }>(
        `select delivery_id, provider, source, body_sha256
         from provider_event_receipts
         order by delivery_id`,
      );
      assert.deepEqual(receipts.rows, [
        {
          delivery_id: "compat-delivery-1",
          provider: "github",
          source: "github",
          body_sha256: null,
        },
        {
          delivery_id: "compat-manual-delivery-1",
          provider: "manual",
          source: "manual",
          body_sha256: null,
        },
      ]);
      const forgejo = await bundle.runtime.query<{ table_name: string; n: number }>(
        `select 'forgejo_connections' as table_name, count(*)::int as n from forgejo_connections
         union all select 'forgejo_credentials', count(*)::int from forgejo_credentials
         union all select 'forgejo_hydrated_events', count(*)::int from forgejo_hydrated_events
         union all select 'forgejo_hydration_cursors', count(*)::int from forgejo_hydration_cursors
         union all select 'forgejo_instances', count(*)::int from forgejo_instances
         union all select 'forgejo_recovery_work', count(*)::int from forgejo_recovery_work
         union all select 'forgejo_repositories', count(*)::int from forgejo_repositories
         union all select 'forgejo_repository_hooks', count(*)::int from forgejo_repository_hooks
         order by table_name`,
      );
      assert.deepEqual(forgejo.rows, [
        { table_name: "forgejo_connections", n: 0 },
        { table_name: "forgejo_credentials", n: 0 },
        { table_name: "forgejo_hydrated_events", n: 0 },
        { table_name: "forgejo_hydration_cursors", n: 0 },
        { table_name: "forgejo_instances", n: 0 },
        { table_name: "forgejo_recovery_work", n: 0 },
        { table_name: "forgejo_repositories", n: 0 },
        { table_name: "forgejo_repository_hooks", n: 0 },
      ]);
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
    insert into projects (id, organization_id, name, slug, status)
      values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'org_t00_compat', 'Compat Manual Project',
              'compat-manual-project', 'active');
    insert into project_configuration_sources
      (organization_id, project_id, kind, github_connection_id, github_repository_id,
       github_repository_full_name, github_default_branch, automatic_deployment_enabled)
      values ('org_t00_compat', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'github',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 4242, 'compat/widgets', 'main', false);
    insert into project_configuration_sources
      (organization_id, project_id, kind, automatic_deployment_enabled)
      values ('org_t00_compat', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'manual', false);
    insert into project_configuration_revisions
      (id, project_id, organization_id, version, source_kind, source_evidence, normalized_configuration,
       content_hash)
      values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              'org_t00_compat', 1, 'github', '{}'::jsonb, '{}'::jsonb, 'compat-hash');
    insert into project_configuration_revisions
      (id, project_id, organization_id, version, source_kind, source_evidence, normalized_configuration,
       content_hash)
      values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              'org_t00_compat', 1, 'manual', '{}'::jsonb, '{}'::jsonb, 'compat-manual-hash');
    insert into provider_event_receipts
      (organization_id, provider, delivery_id, source, payload)
      values ('org_t00_compat', 'github', 'compat-delivery-1', 'github', '{}'::jsonb);
    insert into provider_event_receipts
      (organization_id, provider, delivery_id, source, payload)
      values ('org_t00_compat', 'manual', 'compat-manual-delivery-1', 'manual', '{}'::jsonb);
  `);
}
