import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type QueryResultRow } from "pg";
import { z } from "zod";
import { createDatabase, createPostgresPool } from "./pg.js";
import { createHubApplication } from "../app.js";
import { ProjectConfigurationStore } from "../configuration/store.js";
import { bootstrapInstance } from "../auth/bootstrap.js";
import type { InstanceAuthPolicy } from "../auth/instance-policy.js";
import type { ApiKeyScope } from "../auth/api-key-contract.js";
import type { OperationAuthenticator } from "../auth/operation-auth.js";

const LEGACY_MIGRATIONS = join(process.cwd(), "src/db/migrations");
const DRIZZLE_MIGRATIONS = join(process.cwd(), "drizzle");
const migrationJournalSchema = z.object({
  entries: z.array(
    z.object({
      tag: z.string(),
      when: z.number(),
    }),
  ),
});

describe("database migration application", () => {
  let postgres: StartedPostgreSqlContainer;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  }, 120_000);

  it("migrates production-shaped identity state without changing durable identities", async () => {
    const url = await createHistoricalBaseline({
      postgres,
      prefix: "exact_phase_zero_identity",
      through: "0000_phase_0_spine",
    });
    await seedHistoricalIdentity(url);

    const upgraded = await createDatabase(url);
    await upgraded.close();

    assert.deepEqual(await exactIdentitySnapshot(url), {
      accountId: "account-phase-zero",
      activeOrganizationId: "organization-phase-zero",
      invitationCreated: true,
      invitationId: "invitation-phase-zero",
      invitationRole: "member",
      invitationStatus: "pending",
      memberId: "member-phase-zero",
      memberRole: "owner",
      organizationId: "organization-phase-zero",
      sessionId: "session-phase-zero",
      userId: "user-phase-zero",
    });
  }, 120_000);

  it("marks historical terminal executions complete without scheduling Hub actions", async () => {
    const url = await createHistoricalBaseline({
      postgres,
      prefix: "hub_action_backfill",
      through: "0005_keen_microbe",
    });
    await poolQuery(
      url,
      `insert into organization (id, name, slug) values
         ('organization-actions', 'Organization Actions', 'organization-actions');
       insert into hub_configs (id, org_id, name, version, source, config, is_current) values
         ('20000000-0000-4000-8000-000000000010', 'organization-actions', 'main', 1,
          '{"kind":"admin-seed","userId":"legacy"}', '{}', true);
       insert into machines (id, org_id, source, status, hub_config_version_id) values
         ('30000000-0000-4000-8000-000000000010', 'organization-actions', '{}', 'alive',
          '20000000-0000-4000-8000-000000000010');
       insert into agent_executions (id, machine_id, status, hub_config_version_id) values
         ('50000000-0000-4000-8000-000000000010',
          '30000000-0000-4000-8000-000000000010', 'succeeded',
          '20000000-0000-4000-8000-000000000010'),
         ('50000000-0000-4000-8000-000000000011',
          '30000000-0000-4000-8000-000000000010', 'running',
          '20000000-0000-4000-8000-000000000010')`,
    );

    const database = await createDatabase(url);
    await database.close();

    const actions = await poolQuery<{
      id: string;
      hub_action: string | null;
      action_completed: boolean;
    }>(
      url,
      `select id::text,
              hub_action,
              hub_action_completed_at is not null as action_completed
       from agent_executions
       order by id`,
    );
    assert.deepEqual(actions.rows, [
      {
        id: "50000000-0000-4000-8000-000000000010",
        hub_action: null,
        action_completed: true,
      },
      {
        id: "50000000-0000-4000-8000-000000000011",
        hub_action: null,
        action_completed: false,
      },
    ]);
  }, 120_000);

  it("fails loudly when a tenantless trigger retains project evidence", async () => {
    const url = await createHistoricalBaseline({
      postgres,
      prefix: "phase_three_authorities",
      through: "0011_dazzling_robin_chapel",
    });
    await poolQuery(
      url,
      `insert into triggers
         (id, delivery_id, source, payload, project_id, dropped_reason)
       values
         ('40000000-0000-4000-8000-000000000003', 'project-evidence',
          'github.issue_comment', '{}', '60000000-0000-4000-8000-000000000003',
          'no_matching_trigger')`,
    );

    await assert.rejects(createDatabase(url), /ambiguous or unowned trigger/u);
  });

  it("drops unowned legacy trigger evidence while preserving owned history", async () => {
    const url = await createHistoricalBaseline({
      postgres,
      prefix: "legacy_unscoped_trigger_evidence",
      through: "0010_classy_strong_guy",
    });
    await poolQuery(
      url,
      `insert into organization (id, name, slug)
         values ('organization-production', 'Production', 'production');
       insert into hub_configs (id, org_id, name, version, source, config, is_current)
         values ('20000000-0000-4000-8000-000000000010', 'organization-production', 'main', 1,
                 '{}', '{}', true);
       insert into machines
         (id, org_id, source, status, hub_config_version_id)
       values
         ('30000000-0000-4000-8000-000000000010', 'organization-production', '{}', 'alive',
          '20000000-0000-4000-8000-000000000010');
       insert into triggers
         (id, delivery_id, source, repo, payload, organization_id, dropped_reason)
       values
         ('40000000-0000-4000-8000-000000000010', 'production-owned', 'github.push',
          'getpaseo/paseo', '{}', 'organization-production', null),
         ('40000000-0000-4000-8000-000000000011', 'legacy-github', 'github.push',
          'boudra/paseo-internal-config', '{}', null, 'legacy_unscoped'),
         ('40000000-0000-4000-8000-000000000012', 'legacy-discord', 'discord.mention',
          null, '{}', null, 'github_unbound'),
         ('40000000-0000-4000-8000-000000000013', 'legacy-no-match', 'github.issue_comment',
          null, '{}', null, 'no_matching_trigger'),
         ('40000000-0000-4000-8000-000000000014', 'legacy-discord-unbound', 'discord.mention',
          null, '{}', null, 'discord_unbound'),
         ('40000000-0000-4000-8000-000000000015', 'legacy-lifecycle', 'github.installation',
          null, '{"installation":{"id":"9001"}}', null, 'github_lifecycle'),
         ('40000000-0000-4000-8000-000000000016', 'referenced-history', 'github.issue_comment',
          null, '{}', null, 'github_unbound');
       insert into agent_executions
         (id, machine_id, status, hub_config_version_id, trigger_id)
       values
         ('50000000-0000-4000-8000-000000000010',
          '30000000-0000-4000-8000-000000000010', 'succeeded',
          '20000000-0000-4000-8000-000000000010',
          '40000000-0000-4000-8000-000000000016')`,
    );

    const database = await createDatabase(url);
    await database.close();

    const triggers = await poolQuery<{
      delivery_id: string;
      organization_id: string;
      has_receipt: boolean;
    }>(
      url,
      `select delivery_id, organization_id, receipt_id is not null as has_receipt
       from triggers
       order by delivery_id`,
    );
    assert.deepEqual(triggers.rows, [
      {
        delivery_id: "production-owned",
        organization_id: "organization-production",
        has_receipt: true,
      },
      {
        delivery_id: "referenced-history",
        organization_id: "organization-production",
        has_receipt: true,
      },
    ]);
    assert.equal(
      (
        await poolQuery<{ count: number }>(
          url,
          `select count(*)::integer as count
           from provider_event_receipts
           where delivery_id in ('production-owned', 'referenced-history')`,
        )
      ).rows[0]?.count,
      2,
    );
  }, 120_000);

  it("migrates a production-shaped legacy database without changing durable identities", async () => {
    const fixture = await createLegacyDatabase(postgres, "legacy_upgrade");
    const before = await durableSnapshot(fixture.url);

    const upgraded = await createDatabase(fixture.url);
    await upgraded.close();
    const after = await durableSnapshot(fixture.url);

    assert.deepEqual(after, before);
    assert.deepEqual(await historicalShape(fixture.url), {
      authTables: 7,
      drizzleMigrations: 17,
      legacyArtifacts: null,
      legacyOperatorPrincipals: null,
      bootstrapOrganizationId: fixture.organizationId,
      legacyJournalEntries: 8,
      organizationIds: [fixture.organizationId],
      daemonInvariantChecks: 2,
      enrollmentOrganizationNullable: "YES",
      idleDeadlineNullable: "YES",
      pendingExecutionsWithoutLegacyDeadline: 0,
      unownedEnrollmentTokens: 0,
    });

    const rerun = await createDatabase(fixture.url);
    await rerun.close();
    assert.deepEqual(await durableSnapshot(fixture.url), before);

    const productionDatabase = await createDatabase(fixture.url);
    const upgrade = await LegacyUpgrade.start(
      productionDatabase,
      fixture.organizationId,
      fixture.legacyToken,
      fixture.url,
    );
    try {
      assert.equal(await upgrade.issueEnrollmentToken(), 201);
      assert.equal(await upgrade.enrollLegacyDaemon(), 200);
      assert.equal(await upgrade.installConfiguration(), 201);
      assert.deepEqual(await upgrade.runManualTrigger(), {
        status: 404,
        body: { error: "manual_trigger_not_found" },
      });
    } finally {
      await upgrade.stop();
    }
  });

  it("attaches a migrated customer organization before removing its principal binding", async () => {
    const fixture = await createLegacyDatabase(postgres, "legacy_bootstrap_attach");
    const upgraded = await createDatabase(fixture.url);
    await upgraded.close();
    const before = await durableSnapshot(fixture.url);
    const organization = await poolQuery<{ id: string; name: string; members: number }>(
      fixture.url,
      `select organization.id, organization.name,
              (select count(*)::integer from member where member.organization_id = organization.id) as members
       from organization
       where organization.id = $1`,
      [fixture.organizationId],
    );
    assert.deepEqual(organization.rows, [
      { id: fixture.organizationId, name: fixture.organizationId, members: 0 },
    ]);

    const policy: InstanceAuthPolicy = {
      registrationMode: "invite_only",
      organizationCreation: "disabled",
      bootstrap: {
        organizationName: organization.rows[0]!.name,
        ownerEmail: "migrated-owner@example.test",
        ownerPassword: "temporary-migrated-owner-password",
      },
    };
    const pool = createPostgresPool(fixture.url);
    await bootstrapInstance(pool, policy);
    await pool.end();

    assert.deepEqual(await durableSnapshot(fixture.url), before);
    const completion = await poolQuery<{
      organization_id: string;
      owner_email: string;
      owner_must_change_password: boolean;
      principal_table: string | null;
    }>(
      fixture.url,
      `select instance_bootstrap.organization_id,
              "user".email as owner_email,
              "user".must_change_password as owner_must_change_password,
              to_regclass('public.operator_principals')::text as principal_table
       from instance_bootstrap
       join "user" on "user".id = instance_bootstrap.owner_user_id
       where instance_bootstrap.id = 'default'`,
    );
    assert.deepEqual(completion.rows, [
      {
        organization_id: fixture.organizationId,
        owner_email: "migrated-owner@example.test",
        owner_must_change_password: true,
        principal_table: null,
      },
    ]);
  }, 120_000);

  it("preserves historical configuration evidence that can no longer be resolved", async () => {
    const url = await createHistoricalBaseline({
      postgres,
      prefix: "retired_project_evidence",
      through: "0010_classy_strong_guy",
    });
    const client = new Client({ connectionString: url });
    await client.connect();
    const activeId = randomUUID();
    const historicalId = randomUUID();
    const machineId = randomUUID();
    const executionId = randomUUID();
    await client.query(
      `insert into organization (id, name, slug)
       values
         ('organization-retired', 'Retired evidence', 'retired-evidence'),
         ('organization-bootstrap', 'Bootstrap', 'bootstrap')`,
    );
    await client.query(
      `insert into hub_configs
         (id, org_id, name, version, source, config, errors, is_current)
       values
         ($1, 'organization-retired', 'hub', 2,
          '{"kind":"admin-seed","userId":"legacy"}',
          '{"environments":[],"triggers":[],"indexes":{"github":["acme/current"]}}',
          null, true),
         ($2, 'organization-retired', 'hub', 1,
          '{"kind":"github-sync","repo":"acme/retired"}',
          '{"environments":[{"name":"retired","kind":"daemon","daemon":"retired-daemon"}],"triggers":[],"indexes":{"github":["acme/retired"]}}',
          null, false)`,
      [activeId, historicalId],
    );
    await client.query(
      `insert into machines (id, org_id, source, status, hub_config_version_id)
       values ($1, 'organization-bootstrap', '{}', 'terminated', $2)`,
      [machineId, activeId],
    );
    await client.query(
      `insert into agent_executions
         (id, machine_id, status, hub_config_version_id)
       values ($1, $2, 'succeeded', $3)`,
      [executionId, machineId, activeId],
    );
    await client.end();

    const database = await createDatabase(url);
    await database.close();

    const migrated = await poolQuery<{
      active_configuration_revision_id: string;
      execution_machine_id: string;
      historical_configuration: unknown;
      historical_source_evidence: unknown;
      machine_organization_id: string;
      repositories: number;
      source_kind: string;
    }>(
      url,
      `select project.active_configuration_revision_id::text,
              historical.normalized_configuration as historical_configuration,
              historical.source_evidence as historical_source_evidence,
              (select count(*)::integer from github_repositories) as repositories,
              (select kind from project_configuration_sources
               where project_id = project.id) as source_kind,
              (select org_id from machines where id = '${machineId}') as machine_organization_id,
              (select machine_id::text from agent_executions
               where id = '${executionId}') as execution_machine_id
       from projects project
       join project_configuration_revisions historical on historical.id = '${historicalId}'
       where project.organization_id = 'organization-retired'`,
    );
    assert.deepEqual(migrated.rows, [
      {
        active_configuration_revision_id: activeId,
        execution_machine_id: machineId,
        historical_configuration: {
          environments: [{ daemon: "retired-daemon", kind: "daemon", name: "retired" }],
          triggers: [],
        },
        historical_source_evidence: {
          formattingPreserved: false,
          legacyName: "hub",
          legacyRepositoryNames: ["acme/retired"],
          legacySource: { kind: "github-sync", repo: "acme/retired" },
          legacyVersion: 1,
          rawYamlAvailable: false,
        },
        machine_organization_id: "organization-retired",
        repositories: 0,
        source_kind: "manual",
      },
    ]);
  }, 120_000);

  it("keeps contradictory machine evidence and fails closed for live executions", async () => {
    const terminal = await contradictoryMachineFixture(postgres, "terminal", "succeeded");
    const migrated = await createDatabase(terminal.url);
    await migrated.close();
    assert.deepEqual(
      await poolQuery<{ machine_id: string | null; machine_org_id: string }>(
        terminal.url,
        `select execution.machine_id::text, machine.org_id as machine_org_id
         from machines machine
         cross join agent_executions execution
         where machine.id = '${terminal.machineId}' and execution.id = '${terminal.executionId}'`,
      ).then(({ rows }) => rows),
      [{ machine_id: null, machine_org_id: "organization-b" }],
    );

    const live = await contradictoryMachineFixture(postgres, "live", "running");
    await assert.rejects(
      createDatabase(live.url),
      /inconsistent live execution resource ownership/,
    );
  }, 120_000);

  it("migrates an empty database and reruns as a no-op", async () => {
    const url = databaseUrl(postgres, "fresh");
    const database = await createDatabase(url);
    await database.close();
    const before = await historicalShape(url);

    const rerun = await createDatabase(url);
    await rerun.close();

    assert.deepEqual(await historicalShape(url), before);
  });

  it("keeps a pending enrollment token usable before the first daemon connects", async () => {
    const fixture = await createPendingEnrollmentDatabase(postgres);
    const database = await createDatabase(fixture.url);
    try {
      const enrolled = await database.enrollDaemon({
        daemonId: randomUUID(),
        idempotencyKey: randomUUID(),
        tokenVerifier: createHash("sha256").update(fixture.token).digest("base64url"),
        serverId: "phase-one-server",
        daemonPublicKey: "phase-one-public-key",
        credentialVerifier: "phase-one-credential",
        scopes: ["hub.execution.*"],
        now: new Date(),
      });
      assert.ok(enrolled !== undefined);
      assert.deepEqual((await historicalShape(fixture.url)).organizationIds, ["org_1"]);
    } finally {
      await database.close();
    }
  });

  it("stops before adding Phase 1 constraints when identity data is unsafe", async () => {
    const failures = await rejectedPhaseOneFixtures(postgres);

    assert.match(failures.duplicateMembership, /duplicate organization memberships exist/);
    assert.match(failures.duplicateInvitation, /duplicate normalized pending invitations exist/);
    assert.match(
      failures.memberInvitationCollision,
      /pending invitation exists for current organization member/,
    );
    assert.match(failures.invalidMemberRole, /unknown or multi-valued member role exists/);
    assert.match(failures.invalidInvitation, /unknown or missing invitation role exists/);
    assert.match(failures.invalidInvitationStatus, /unknown invitation status exists/);
  });

  it("activates and rolls back immutable deployments atomically in PostgreSQL", async () => {
    const url = databaseUrl(postgres, "deployment_lifecycle");
    const database = await createDatabase(url);
    try {
      const [project, foreignProject] = await createProjectFixtures(database, url);
      const first = await database.insertProjectConfigurationRevision(revision(project.id));
      const second = await database.insertProjectConfigurationRevision(revision(project.id));
      const invalid = await database.insertProjectConfigurationRevision(
        revision(project.id, { formErrors: ["invalid"] }),
      );
      const foreign = await database.insertProjectConfigurationRevision(
        revision(foreignProject.id),
      );
      const connectionId = randomUUID();
      await poolQuery(
        url,
        `insert into github_connections
           (id, organization_id, installation_id, slug, account_id, account_login, account_type, status)
         values ('${connectionId}', 'organization-a', 9101, 'fixture-github', 'account-9101',
                 'fixture', 'Organization', 'active')`,
      );
      const firstRoute = {
        provider: "github" as const,
        connectionId,
        resourceId: null,
        triggerName: "first-trigger",
      };
      const secondRoute = { ...firstRoute, triggerName: "second-trigger" };
      const secondRoutes = [secondRoute, { ...secondRoute, triggerName: "second-trigger-2" }];

      await database.activateProjectConfigurationRevision(project.id, first.id, [firstRoute]);
      const activated = await database.activateProjectConfigurationRevision(
        project.id,
        second.id,
        secondRoutes,
      );
      const accepted = await database.acceptGitHubTrigger({
        installationId: 9101,
        repositoryId: 9001,
        deliveryId: "github-duplicate-project-routes",
        source: "github.push",
        payload: {},
        receivedAt: new Date(0),
      });
      assert.equal(accepted.status, "accepted");
      if (accepted.status !== "accepted") return;
      assert.equal(accepted.triggers.length, 1);
      const rolledBack = await database.rollbackProjectConfiguration(project.id, first.id, [
        firstRoute,
      ]);

      assert.equal(activated.id, second.id);
      assert.equal(rolledBack.id, first.id);
      assert.deepEqual(
        (
          await poolQuery<{ configuration_revision_id: string; trigger_name: string }>(
            url,
            `select configuration_revision_id, trigger_name
             from project_trigger_routes where project_id = '${project.id}'`,
          )
        ).rows.sort((left, right) => left.trigger_name.localeCompare(right.trigger_name)),
        [{ configuration_revision_id: first.id, trigger_name: "first-trigger" }],
      );
      await assert.rejects(
        database.activateProjectConfigurationRevision(project.id, invalid.id),
        /invalid configuration revision/,
      );
      await assert.rejects(
        database.activateProjectConfigurationRevision(project.id, foreign.id),
        /configuration revision not found/,
      );
    } finally {
      await database.close();
    }
  });

  it("claims a concurrent provider receipt without surfacing a unique-index failure", async () => {
    const url = databaseUrl(postgres, "concurrent_provider_receipt");
    const database = await createDatabase(url);
    try {
      const [project] = await createProjectFixtures(database, url);
      const connectionId = randomUUID();
      await poolQuery(
        url,
        `insert into github_connections
           (id, organization_id, installation_id, slug, account_id, account_login, account_type, status)
         values ('${connectionId}', 'organization-a', 9201, 'receipt-github', 'account-9201',
                 'receipt', 'Organization', 'active')`,
      );
      const revisionRecord = await database.insertProjectConfigurationRevision(
        revision(project.id),
      );
      await database.activateProjectConfigurationRevision(project.id, revisionRecord.id, [
        { provider: "github", connectionId, resourceId: null, triggerName: "receipt-trigger" },
      ]);
      const input = {
        installationId: 9201,
        repositoryId: 9202,
        deliveryId: "concurrent-provider-receipt",
        signatureHash: "concurrent-provider-signature",
        source: "github.push",
        payload: {},
        receivedAt: new Date(0),
      };

      const results = await Promise.all([
        database.acceptGitHubTrigger(input),
        database.acceptGitHubTrigger(input),
      ]);

      assert.deepEqual(results.map((result) => result.status).sort(), ["accepted", "duplicate"]);
    } finally {
      await database.close();
    }
  });

  it("rebuilds runtime routes when switching a project to manual authority", async () => {
    const url = databaseUrl(postgres, "manual_authority_routes");
    const database = await createDatabase(url);
    try {
      const [project] = await createProjectFixtures(database, url);
      const connectionId = randomUUID();
      await poolQuery(
        url,
        `insert into github_connections
           (id, organization_id, installation_id, slug, account_id, account_login, account_type, status)
         values ('${connectionId}', 'organization-a', 9251, 'manual-authority-github', 'account-9251',
                 'manual-authority', 'Organization', 'active')`,
      );
      const store = new ProjectConfigurationStore(database, project.id);
      const configuration = {
        environments: [{ name: "runner", kind: "docker", image: "paseo/test" }],
        triggers: [
          {
            name: "github-trigger",
            on: "github.push",
            environment: "runner",
            filters: { from_users: ["user-1"] },
            agent: { provider: "test", mode: "default" },
            prompt: "Handle the push",
          },
        ],
      };
      const initial = await store.insertManualRevision({
        rawYaml: null,
        rawConfiguration: configuration,
        userId: "project-user",
      });
      await store.activate(initial.id);

      const switched = await store.switchToManual("project-user");
      const accepted = await database.acceptGitHubTrigger({
        installationId: 9251,
        repositoryId: 9252,
        deliveryId: "manual-authority-route",
        source: "github.push",
        payload: {},
        receivedAt: new Date(0),
      });

      assert.equal(switched.revision.sourceKind, "manual");
      assert.equal(accepted.status, "accepted");
      if (accepted.status !== "accepted") return;
      assert.equal(accepted.triggers[0]?.projectId, project.id);
    } finally {
      await database.close();
    }
  }, 120_000);

  it("claims concurrent manual receipts without unique-index failures", async () => {
    const url = databaseUrl(postgres, "concurrent_manual_receipts");
    const database = await createDatabase(url);
    try {
      const [project] = await createProjectFixtures(database, url);
      const manualInput = {
        organizationId: "organization-a",
        projectId: project.id,
        deliveryId: "concurrent-manual-receipt",
        signatureHash: "concurrent-manual-signature",
        source: "manual.run",
        payload: {},
        receivedAt: new Date(0),
      };
      const manualResults = await Promise.all([
        database.persistManualTrigger(manualInput),
        database.persistManualTrigger(manualInput),
      ]);
      assert.deepEqual(manualResults.map((result) => result.status).sort(), [
        "accepted",
        "duplicate",
      ]);
    } finally {
      await database.close();
    }
  }, 120_000);

  it("claims concurrent lifecycle receipts without unique-index failures", async () => {
    const url = databaseUrl(postgres, "concurrent_lifecycle_receipts");
    const database = await createDatabase(url);
    try {
      await createProjectFixtures(database, url);
      const connectionId = randomUUID();
      await poolQuery(
        url,
        `insert into github_connections
           (id, organization_id, installation_id, slug, account_id, account_login, account_type, status)
         values ('${connectionId}', 'organization-a', 9261, 'lifecycle-github', 'account-9261',
                 'lifecycle', 'Organization', 'active')`,
      );
      const lifecycleInput = {
        installationId: 9261,
        deliveryId: "concurrent-lifecycle-receipt",
        signatureHash: "concurrent-lifecycle-signature",
        source: "github.installation",
        payload: {},
        receivedAt: new Date(0),
      };
      const lifecycleResults = await Promise.all([
        database.claimGitHubLifecycle(lifecycleInput),
        database.claimGitHubLifecycle(lifecycleInput),
      ]);
      assert.deepEqual(lifecycleResults.map((result) => result.status).sort(), [
        "claimed",
        "duplicate",
      ]);
    } finally {
      await database.close();
    }
  }, 120_000);

  it("removes a lifecycle-deleted GitHub connection with its dependent records", async () => {
    const url = databaseUrl(postgres, "lifecycle_connection_removal");
    const database = await createDatabase(url);
    try {
      const [project] = await createProjectFixtures(database, url);
      const connectionId = randomUUID();
      await poolQuery(
        url,
        `insert into github_connections
           (id, organization_id, installation_id, slug, account_id, account_login, account_type, status)
         values ('${connectionId}', 'organization-a', 9271, 'lifecycle-removal-github', 'account-9271',
                 'lifecycle-removal', 'Organization', 'active');
         update project_configuration_sources
         set kind = 'github', github_connection_id = '${connectionId}', github_repository_id = 9272,
             github_repository_full_name = 'acme/lifecycle-removal', github_default_branch = 'main'
         where project_id = '${project.id}';
         insert into configuration_sync_attempts
           (organization_id, project_id, github_connection_id, github_repository_id, outcome, evidence)
         values ('organization-a', '${project.id}', '${connectionId}', 9272, 'applied', '{}');`,
      );
      const routeRevision = await database.insertProjectConfigurationRevision({
        projectId: project.id,
        sourceKind: "manual",
        sourceEvidence: { kind: "lifecycle-route-test" },
        normalizedConfiguration: { environments: [], triggers: [] },
        contentHash: randomUUID(),
      });
      await database.activateProjectConfigurationRevision(project.id, routeRevision.id, [
        {
          provider: "github",
          connectionId,
          resourceId: "9272",
          triggerName: "lifecycle-removal-route",
        },
      ]);

      const claim = await database.claimGitHubLifecycle({
        installationId: 9271,
        deliveryId: "lifecycle-removal",
        signatureHash: "lifecycle-removal-signature",
        source: "github.installation",
        payload: {},
        receivedAt: new Date(0),
      });
      assert.equal(claim.status, "claimed");
      if (claim.status !== "claimed") return;

      await database.applyGitHubLifecycle(claim, { status: "absent", removeBinding: true });

      const state = await poolQuery<{
        connections: number;
        source_kind: string;
        source_connection: string | null;
        sync_organization: string;
        sync_connection: string | null;
        routes: number;
      }>(
        url,
        `select
           (select count(*)::integer from github_connections where id = '${connectionId}') as connections,
           (select kind from project_configuration_sources where project_id = '${project.id}') as source_kind,
           (select github_connection_id::text from project_configuration_sources where project_id = '${project.id}') as source_connection,
           (select organization_id from configuration_sync_attempts where project_id = '${project.id}') as sync_organization,
           (select github_connection_id::text from configuration_sync_attempts where project_id = '${project.id}') as sync_connection,
           (select count(*)::integer from project_trigger_routes where project_id = '${project.id}') as routes`,
      );
      assert.deepEqual(state.rows[0], {
        connections: 0,
        source_kind: "manual",
        source_connection: null,
        sync_organization: "organization-a",
        sync_connection: null,
        routes: 0,
      });
    } finally {
      await database.close();
    }
  }, 120_000);

  it("exposes an unrouted provider receipt through the organization activity read model", async () => {
    const url = databaseUrl(postgres, "unrouted_receipt_activity");
    const database = await createDatabase(url);
    try {
      await createProjectFixtures(database, url);
      const connectionId = randomUUID();
      await poolQuery(
        url,
        `insert into github_connections
           (id, organization_id, installation_id, slug, account_id, account_login, account_type, status)
         values ('${connectionId}', 'organization-a', 9301, 'activity-github', 'account-9301',
                 'activity', 'Organization', 'active')`,
      );
      const result = await database.acceptGitHubTrigger({
        installationId: 9301,
        repositoryId: 9302,
        deliveryId: "unrouted-activity-receipt",
        signatureHash: "unrouted-activity-signature",
        source: "github.push",
        payload: {},
        receivedAt: new Date(0),
      });

      assert.equal(result.status, "dropped");
      assert.equal(
        (await database.listUnroutedTriggersForOrganization("organization-a")).some(
          (event) => event.deliveryId === "unrouted-activity-receipt",
        ),
        true,
      );
    } finally {
      await database.close();
    }
  });

  it("preserves rollback lineage across concurrent deployment activation", async () => {
    const url = databaseUrl(postgres, "concurrent_deployments");
    const database = await createDatabase(url);
    try {
      const [project] = await createProjectFixtures(database, url);
      const first = await database.insertProjectConfigurationRevision(revision(project.id));
      const second = await database.insertProjectConfigurationRevision(revision(project.id));
      const third = await database.insertProjectConfigurationRevision(revision(project.id));
      await database.activateProjectConfigurationRevision(project.id, first.id);

      await Promise.all([
        database.activateProjectConfigurationRevision(project.id, second.id),
        database.activateProjectConfigurationRevision(project.id, third.id),
      ]);

      const current = await database.findActiveProjectConfiguration(project.id);
      assert.ok(current?.id === second.id || current?.id === third.id);
      const target = await database.findProjectConfigurationRollbackTarget(project.id);
      assert.ok(target !== undefined);
      const rolledBack = await database.rollbackProjectConfiguration(project.id, target.id, []);
      assert.equal(rolledBack.version, current.version - 1);
    } finally {
      await database.close();
    }
  });

  it("preserves rollback lineage when activation of the current deployment is retried", async () => {
    const url = databaseUrl(postgres, "repeated_deployment_activation");
    const database = await createDatabase(url);
    try {
      const [project] = await createProjectFixtures(database, url);
      const first = await database.insertProjectConfigurationRevision(revision(project.id));
      const second = await database.insertProjectConfigurationRevision(revision(project.id));
      await database.activateProjectConfigurationRevision(project.id, first.id);

      const concurrent = await Promise.all([
        database.activateProjectConfigurationRevision(project.id, second.id),
        database.activateProjectConfigurationRevision(project.id, second.id),
      ]);
      const retried = await database.activateProjectConfigurationRevision(project.id, second.id);
      const rolledBack = await database.rollbackProjectConfiguration(project.id, first.id, []);

      assert.deepEqual(
        [...concurrent, retried].map(({ id }) => id),
        Array(3).fill(second.id),
      );
      assert.equal(rolledBack.id, first.id);
    } finally {
      await database.close();
    }
  });
});

interface RejectedPhaseOneFixtures {
  duplicateMembership: string;
  duplicateInvitation: string;
  memberInvitationCollision: string;
  invalidMemberRole: string;
  invalidInvitation: string;
  invalidInvitationStatus: string;
}

async function rejectedPhaseOneFixtures(
  postgres: StartedPostgreSqlContainer,
): Promise<RejectedPhaseOneFixtures> {
  return {
    duplicateMembership: await rejectedPhaseOneFixture(
      postgres,
      "duplicate_membership",
      async (client) => {
        await seedMigrationIdentity(client);
        await client.query(
          `insert into member (id, organization_id, user_id, role) values
            ('member-one', 'organization-fixture', 'user-fixture', 'owner'),
            ('member-two', 'organization-fixture', 'user-fixture', 'admin')`,
        );
      },
    ),
    duplicateInvitation: await rejectedPhaseOneFixture(
      postgres,
      "duplicate_invitation",
      async (client) => {
        await seedMigrationIdentity(client);
        await client.query(
          `insert into invitation
            (id, organization_id, email, role, status, expires_at, inviter_id) values
            ('invite-one', 'organization-fixture', 'Person@example.com', 'member', 'pending', now() + interval '1 day', 'user-fixture'),
            ('invite-two', 'organization-fixture', 'person@example.com', 'admin', 'pending', now() + interval '1 day', 'user-fixture')`,
        );
      },
    ),
    memberInvitationCollision: await rejectedPhaseOneFixture(
      postgres,
      "member_invitation_collision",
      async (client) => {
        await seedMigrationIdentity(client);
        await client.query(`
          insert into member (id, organization_id, user_id, role)
            values ('member-collision', 'organization-fixture', 'user-fixture', 'member');
          insert into invitation
            (id, organization_id, email, role, status, expires_at, inviter_id)
            values ('invite-collision', 'organization-fixture', 'FIXTURE@example.com',
                    'member', 'pending', now() + interval '1 day', 'user-fixture');
        `);
      },
    ),
    invalidMemberRole: await rejectedPhaseOneFixture(
      postgres,
      "invalid_member_role",
      async (client) => {
        await seedMigrationIdentity(client);
        await client.query(
          `insert into member (id, organization_id, user_id, role)
           values ('member-invalid', 'organization-fixture', 'user-fixture', 'owner,admin')`,
        );
      },
    ),
    invalidInvitation: await rejectedPhaseOneFixture(
      postgres,
      "invalid_invitation",
      async (client) => {
        await seedMigrationIdentity(client);
        await client.query(
          `insert into invitation
            (id, organization_id, email, role, status, expires_at, inviter_id)
           values ('invite-invalid', 'organization-fixture', 'person@example.com', null, 'pending', now() + interval '1 day', 'user-fixture')`,
        );
      },
    ),
    invalidInvitationStatus: await rejectedPhaseOneFixture(
      postgres,
      "invalid_invitation_status",
      async (client) => {
        await seedMigrationIdentity(client);
        await client.query(
          `insert into invitation
            (id, organization_id, email, role, status, expires_at, inviter_id)
           values ('invite-invalid-status', 'organization-fixture', 'person@example.com',
                   'member', 'mystery', now() + interval '1 day', 'user-fixture')`,
        );
      },
    ),
  };
}

async function rejectedPhaseOneFixture(
  postgres: StartedPostgreSqlContainer,
  name: string,
  seed: (client: Client) => Promise<void>,
): Promise<string> {
  const url = await createHistoricalBaseline({
    postgres,
    prefix: name,
    through: "0000_phase_0_spine",
  });
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await seed(client);
  } finally {
    await client.end();
  }
  try {
    const migrated = await createDatabase(url);
    await migrated.close();
    throw new Error("unsafe Phase 1 fixture migrated successfully");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function seedMigrationIdentity(client: Client): Promise<void> {
  await client.query(`
    insert into organization (id, name, slug)
      values ('organization-fixture', 'Fixture', 'fixture');
    insert into "user" (id, name, email)
      values ('user-fixture', 'Fixture User', 'fixture@example.com');
  `);
}

function revision(projectId: string, validationErrors?: unknown) {
  return {
    projectId,
    sourceKind: "manual" as const,
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: randomUUID(),
    ...(validationErrors === undefined ? {} : { validationErrors }),
  };
}

async function createProjectFixtures(
  database: Awaited<ReturnType<typeof createDatabase>>,
  url: string,
) {
  await poolQuery(
    url,
    `insert into "user" (id, name, email) values
       ('project-user', 'Project User', 'project@example.test');
     insert into organization (id, name, slug) values
       ('organization-a', 'Organization A', 'organization-a'),
       ('organization-b', 'Organization B', 'organization-b');
     insert into member (id, organization_id, user_id, role) values
       ('member-a', 'organization-a', 'project-user', 'owner'),
       ('member-b', 'organization-b', 'project-user', 'owner');`,
  );
  return Promise.all([
    database.createProject({
      organizationId: "organization-a",
      name: "Project A",
      slug: "project-a",
      createdByUserId: "project-user",
    }),
    database.createProject({
      organizationId: "organization-b",
      name: "Project B",
      slug: "project-b",
      createdByUserId: "project-user",
    }),
  ]);
}

interface LegacyFixture {
  url: string;
  organizationId: string;
  legacyToken: string;
}

async function createLegacyDatabase(
  postgres: StartedPostgreSqlContainer,
  prefix: string,
): Promise<LegacyFixture> {
  const { client, url } = await createLegacySchema(postgres, prefix);
  const organizationId = "organization-legacy";
  const configId = randomUUID();
  const machineId = randomUUID();
  const executionId = randomUUID();
  const daemonId = randomUUID();
  const credentialVerifier = "stable-credential-verifier";
  const legacyToken = "legacy-enrollment-token";
  await client.query(
    `insert into hub_configs
      (id, org_id, name, version, source, config, errors, is_current)
     values ($1, $2, 'hub', 1, $3, $4, null, true)`,
    [
      configId,
      organizationId,
      { kind: "admin-seed", userId: "operator" },
      { environments: [], triggers: [] },
    ],
  );
  await client.query(
    `insert into daemon_enrollment_tokens (id, verifier, expires_at)
     values ($1, $2, now() + interval '1 day')`,
    [randomUUID(), createHash("sha256").update(legacyToken).digest("base64url")],
  );
  await client.query(
    `insert into machines (id, org_id, source, status, hub_config_version_id)
     values ($1, $2, $3, 'alive', $4)`,
    [machineId, organizationId, { kind: "daemon", daemonId }, configId],
  );
  await client.query(
    `insert into daemons
      (id, idempotency_key, enrollment_verifier, slug, machine_id, server_id,
       daemon_public_key, credential_verifier, scopes, status)
     values ($1, 'stable-enrollment', 'stable-enrollment-verifier', 'daemon-legacy', $2,
       'server-legacy', 'public-key', $3, '["hub.execution.*"]', 'active')`,
    [daemonId, machineId, credentialVerifier],
  );
  await client.query(
    `insert into agent_executions
      (id, machine_id, status, trigger_context, output_context, hub_config_version_id,
       completion_token_hash, daemon_id, daemon_agent_id)
     values ($1, $2, 'running', '{}', '{}', $3, 'stable-completion-token', $4, 'agent-legacy')`,
    [executionId, machineId, configId, daemonId],
  );
  await client.query(
    `create table registered_daemons (slug text primary key, connection_options jsonb)`,
  );
  await client.query(
    `create table operator_principals (
       principal_id text primary key,
       organization_id text not null,
       created_at timestamptz not null default now()
     )`,
  );
  await client.query(
    `insert into operator_principals (principal_id, organization_id)
     values ('legacy-operator', $1)`,
    [organizationId],
  );
  await client.end();
  return { url, organizationId, legacyToken };
}

async function createPendingEnrollmentDatabase(postgres: StartedPostgreSqlContainer) {
  const { client, url } = await createLegacySchema(postgres, "pending_enrollment");
  const token = "pending-legacy-enrollment-token";
  await client.query(
    `insert into daemon_enrollment_tokens (id, verifier, expires_at)
     values ($1, $2, now() + interval '1 day')`,
    [randomUUID(), createHash("sha256").update(token).digest("base64url")],
  );
  await client.end();
  return { url, token };
}

async function contradictoryMachineFixture(
  postgres: StartedPostgreSqlContainer,
  prefix: string,
  executionStatus: "running" | "succeeded",
) {
  const url = await createHistoricalBaseline({
    postgres,
    prefix: `contradictory_machine_${prefix}`,
    through: "0010_classy_strong_guy",
  });
  const client = new Client({ connectionString: url });
  await client.connect();
  const configA = randomUUID();
  const configB = randomUUID();
  const machineId = randomUUID();
  const executionId = randomUUID();
  try {
    await client.query(
      `insert into organization (id, name, slug)
       values ('organization-a', 'A', 'a'), ('organization-b', 'B', 'b')`,
    );
    await client.query(
      `insert into hub_configs (id, org_id, name, version, source, config, is_current)
       values
         ($1, 'organization-a', 'a', 1, '{}', '{"environments":[],"triggers":[]}', true),
         ($2, 'organization-b', 'b', 1, '{}', '{"environments":[],"triggers":[]}', true)`,
      [configA, configB],
    );
    await client.query(
      `insert into machines (id, org_id, source, status, hub_config_version_id)
       values ($1, 'organization-b', '{}', 'alive', $2)`,
      [machineId, configB],
    );
    await client.query(
      `insert into agent_executions (id, machine_id, status, hub_config_version_id)
       values ($1, $2, $3, $4)`,
      [executionId, machineId, executionStatus, configA],
    );
  } finally {
    await client.end();
  }
  return { url, machineId, executionId };
}

async function createLegacySchema(postgres: StartedPostgreSqlContainer, prefix: string) {
  const url = databaseUrl(postgres, prefix);
  const databaseName = new URL(url).pathname.slice(1);
  const admin = new Client({ connectionString: postgres.getConnectionUri() });
  await admin.connect();
  await admin.query(`create database "${databaseName}"`);
  await admin.end();

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`
    create table paseo_hub_migrations (
      filename text primary key,
      applied_at timestamp with time zone not null default now()
    )
  `);
  const files = (await readdir(LEGACY_MIGRATIONS)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const migration = await readFile(join(LEGACY_MIGRATIONS, file), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) await client.query(statement);
    }
    await client.query("insert into paseo_hub_migrations (filename) values ($1)", [file]);
  }
  return { client, url };
}

interface HistoricalBaselineOptions {
  postgres: StartedPostgreSqlContainer;
  prefix: string;
  through: string;
}

async function createHistoricalBaseline(options: HistoricalBaselineOptions): Promise<string> {
  const baseline = await createLegacySchema(options.postgres, options.prefix);
  await baseline.client.end();
  await applyHistoricalMigrations(baseline.url, options.through);
  return baseline.url;
}

async function applyHistoricalMigrations(url: string, through: string): Promise<void> {
  const journal = migrationJournalSchema.parse(
    JSON.parse(await readFile(join(DRIZZLE_MIGRATIONS, "meta/_journal.json"), "utf8")),
  );
  const migrations = [];
  for (const entry of journal.entries) {
    migrations.push(entry);
    if (entry.tag === through) break;
  }
  if (migrations.at(-1)?.tag !== through) {
    throw new Error(`historical migration is absent from the journal: ${through}`);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("create schema if not exists drizzle");
    await client.query(`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);
    await client.query("begin");
    try {
      for (const entry of migrations) {
        const migration = await readFile(join(DRIZZLE_MIGRATIONS, `${entry.tag}.sql`), "utf8");
        await applyMigration(client, migration);
        const hash = createHash("sha256").update(migration).digest("hex");
        await client.query(
          `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
          [hash, entry.when],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await client.end();
  }
}

async function applyMigration(client: Client, migration: string): Promise<void> {
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) await client.query(statement);
  }
}

async function durableSnapshot(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const relation = await client.query<{ legacy: boolean }>(
      `select to_regclass('public.hub_configs') is not null as legacy`,
    );
    const configurationTable = relation.rows[0]?.legacy
      ? "hub_configs"
      : "project_configuration_revisions";
    const rows = await client.query<DurableSnapshot>(`
      select
        (select count(*)::integer from triggers) as triggers,
        (select count(*)::integer from machines) as machines,
        (select count(*)::integer from agent_executions) as executions,
        (select count(*)::integer from ${configurationTable}) as configs,
        (select count(*)::integer from daemons) as daemons,
        (select count(*)::integer from daemon_enrollment_tokens) as enrollment_tokens,
        (select id::text from machines limit 1) as machine_id,
        (select id::text from agent_executions limit 1) as execution_id,
        (select id::text from ${configurationTable} limit 1) as config_id,
        (select id::text from daemons limit 1) as daemon_id,
        (select credential_verifier from daemons limit 1) as credential_verifier,
        (select verifier from daemon_enrollment_tokens limit 1) as enrollment_verifier,
        (select consumed_at from daemon_enrollment_tokens limit 1) as enrollment_consumed_at
    `);
    const row = rows.rows[0];
    if (row === undefined) throw new Error("durable snapshot returned no row");
    return row;
  } finally {
    await client.end();
  }
}

interface DurableSnapshot extends QueryResultRow {
  triggers: number;
  machines: number;
  executions: number;
  configs: number;
  daemons: number;
  enrollment_tokens: number;
  machine_id: string;
  execution_id: string;
  config_id: string;
  daemon_id: string;
  credential_verifier: string;
  enrollment_verifier: string;
  enrollment_consumed_at: Date | null;
}

async function historicalShape(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const shape = await client.query<{
      auth_tables: number;
      drizzle_migrations: number;
      legacy_artifacts: string | null;
      legacy_operator_principals: string | null;
      bootstrap_organization_id: string | null;
      legacy_journal_entries: number;
      pending_executions_without_legacy_deadline: number;
      unowned_enrollment_tokens: number;
      daemon_invariant_checks: number;
      enrollment_organization_nullable: string;
      idle_deadline_nullable: string;
    }>(`
      select
        (select count(*)::integer from information_schema.tables
         where table_schema = 'public'
           and table_name in ('user', 'session', 'account', 'verification', 'organization', 'member', 'invitation')) as auth_tables,
        (select count(*)::integer from drizzle.__drizzle_migrations) as drizzle_migrations,
        to_regclass('public.registered_daemons')::text as legacy_artifacts,
        to_regclass('public.operator_principals')::text as legacy_operator_principals,
        (select organization_id from instance_bootstrap where id = 'default') as bootstrap_organization_id,
        (select count(*)::integer from paseo_hub_migrations) as legacy_journal_entries,
        (select count(*)::integer from agent_executions
         where status in ('spawning', 'running')
           and deadline_at is distinct from started_at + interval '30 minutes') as pending_executions_without_legacy_deadline,
        (select count(*)::integer from daemon_enrollment_tokens
         where organization_id is null) as unowned_enrollment_tokens,
        (select count(*)::integer from pg_constraint
         where conrelid = 'daemons'::regclass
           and conname in ('daemons_status_check', 'daemons_presence_check')) as daemon_invariant_checks,
        (select is_nullable from information_schema.columns
         where table_schema = 'public'
           and table_name = 'daemon_enrollment_tokens'
           and column_name = 'organization_id') as enrollment_organization_nullable,
        (select is_nullable from information_schema.columns
         where table_schema = 'public'
           and table_name = 'agent_executions'
           and column_name = 'idle_deadline_at') as idle_deadline_nullable
    `);
    const organizations = await client.query<{ id: string }>(
      `select id from organization order by id`,
    );
    const row = shape.rows[0]!;
    return {
      authTables: row.auth_tables,
      drizzleMigrations: row.drizzle_migrations,
      legacyArtifacts: row.legacy_artifacts,
      legacyOperatorPrincipals: row.legacy_operator_principals,
      bootstrapOrganizationId: row.bootstrap_organization_id,
      legacyJournalEntries: row.legacy_journal_entries,
      organizationIds: organizations.rows.map(({ id }) => id),
      daemonInvariantChecks: row.daemon_invariant_checks,
      enrollmentOrganizationNullable: row.enrollment_organization_nullable,
      idleDeadlineNullable: row.idle_deadline_nullable,
      pendingExecutionsWithoutLegacyDeadline: row.pending_executions_without_legacy_deadline,
      unownedEnrollmentTokens: row.unowned_enrollment_tokens,
    };
  } finally {
    await client.end();
  }
}

class LegacyUpgrade {
  private constructor(
    private readonly database: Awaited<ReturnType<typeof createDatabase>>,
    private readonly operations: ReturnType<typeof createHubApplication>["operations"],
    private readonly hub: ReturnType<typeof createHubApplication>["hub"],
    private readonly apiKey: string,
    private readonly legacyToken: string,
  ) {}

  static async start(
    database: Awaited<ReturnType<typeof createDatabase>>,
    organizationId: string,
    legacyToken: string,
    url: string,
  ) {
    const apiKey = "paseo_pk_migration_test";
    const apiKeyId = "00000000-0000-4000-8000-0000000000bb";
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(
        `insert into organization_api_keys
           (id, organization_id, name, prefix, verifier, scopes)
         values ($1, $2, 'Migration test', 'paseo_pk_migration', 'migration-verifier', $3)`,
        [apiKeyId, organizationId, ["configuration:install", "runs:dispatch", "daemons:enroll"]],
      );
    } finally {
      await client.end();
    }
    const operationAuth: OperationAuthenticator = {
      async authorize(request: Request, _scope: ApiKeyScope) {
        return request.headers.get("authorization") === `Bearer ${apiKey}`
          ? {
              status: "authorized" as const,
              access: {
                kind: "apiKey" as const,
                keyId: apiKeyId,
                organizationId,
                scopes: ["configuration:install", "runs:dispatch", "daemons:enroll"] as const,
              },
            }
          : { status: "unauthorized" as const };
      },
    };
    const application = createHubApplication({
      database,
      operationAuth,
    });
    await application.hub.start();
    return new LegacyUpgrade(
      database,
      application.operations,
      application.hub,
      apiKey,
      legacyToken,
    );
  }

  async issueEnrollmentToken(): Promise<number> {
    return (
      await this.operations.handleEnrollmentToken(
        this.request("/api/daemons/enrollment-tokens", { method: "POST" }),
      )
    ).status;
  }

  async enrollLegacyDaemon(): Promise<number> {
    const response = await this.operations.handleDaemonEnrollment(
      new Request("http://upgrade.test/api/daemons/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.legacyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          daemonId: randomUUID(),
          idempotencyKey: "legacy-upgrade-proof",
          serverId: "legacy-server",
          daemonPublicKey: "legacy-public-key",
          credentialVerifier: "legacy-credential",
        }),
      }),
    );
    return response.status;
  }

  async installConfiguration(): Promise<number> {
    const response = await this.operations.handleConfigurationInstall(
      this.request("/api/configurations/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectSlug: "default",
          yaml: "environments:\n  - name: production\n    kind: docker\n    image: paseo/runner\ntriggers: []",
        }),
      }),
    );
    return response.status;
  }

  async runManualTrigger(): Promise<{ status: number; body: unknown }> {
    const response = await this.operations.handleManualRun(
      this.request("/api/manual-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectSlug: "default",
          trigger: "missing",
          actor: "legacy-operator",
          deliveryKey: "upgrade-proof",
          input: {},
        }),
      }),
    );
    return { status: response.status, body: await response.json() };
  }

  async stop(): Promise<void> {
    await this.hub.stop();
    await this.database.close();
  }

  private request(path: string, init: RequestInit): Request {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.apiKey}`);
    return new Request(`http://upgrade.test${path}`, { ...init, headers });
  }
}

async function seedHistoricalIdentity(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      insert into "user" (id, name, email)
        values ('user-phase-zero', 'Phase Zero User', 'phase-zero@example.com');
      insert into organization (id, name, slug)
        values ('organization-phase-zero', 'Phase Zero', 'phase-zero');
      insert into account (id, account_id, provider_id, user_id, password)
        values ('account-phase-zero', 'phase-zero@example.com', 'credential',
                'user-phase-zero', 'immutable-password-hash');
      insert into session (id, expires_at, token, user_id, active_organization_id)
        values ('session-phase-zero', now() + interval '1 day', 'phase-zero-session-token',
                'user-phase-zero', 'organization-phase-zero');
      insert into member (id, organization_id, user_id, role)
        values ('member-phase-zero', 'organization-phase-zero', 'user-phase-zero', 'owner');
      insert into invitation
        (id, organization_id, email, role, status, expires_at, inviter_id)
        values ('invitation-phase-zero', 'organization-phase-zero', 'invitee@example.com',
                'member', 'pending', now() + interval '1 day', 'user-phase-zero');
    `);
  } finally {
    await client.end();
  }
}

async function exactIdentitySnapshot(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{
      account_id: string;
      active_organization_id: string;
      invitation_created: boolean;
      invitation_id: string;
      invitation_role: string;
      invitation_status: string;
      member_id: string;
      member_role: string;
      organization_id: string;
      session_id: string;
      user_id: string;
    }>(`
      select account.id as account_id,
             session.active_organization_id,
             invitation.created_at is not null as invitation_created,
             invitation.id as invitation_id,
             invitation.role as invitation_role,
             invitation.status as invitation_status,
             member.id as member_id,
             member.role as member_role,
             organization.id as organization_id,
             session.id as session_id,
             "user".id as user_id
      from "user"
      join account on account.user_id = "user".id
      join session on session.user_id = "user".id
      join member on member.user_id = "user".id
      join organization on organization.id = member.organization_id
      join invitation on invitation.organization_id = organization.id
      where "user".id = 'user-phase-zero'
    `);
    const row = result.rows[0]!;
    return {
      accountId: row.account_id,
      activeOrganizationId: row.active_organization_id,
      invitationCreated: row.invitation_created,
      invitationId: row.invitation_id,
      invitationRole: row.invitation_role,
      invitationStatus: row.invitation_status,
      memberId: row.member_id,
      memberRole: row.member_role,
      organizationId: row.organization_id,
      sessionId: row.session_id,
      userId: row.user_id,
    };
  } finally {
    await client.end();
  }
}

function databaseUrl(postgres: StartedPostgreSqlContainer, prefix: string): string {
  const url = new URL(postgres.getConnectionUri());
  url.pathname = `/${prefix}_${randomUUID().replaceAll("-", "")}`;
  return url.toString();
}

async function poolQuery<Row extends QueryResultRow = QueryResultRow>(
  url: string,
  text: string,
  values: unknown[] = [],
) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query<Row>(text, values);
  } finally {
    await client.end();
  }
}
