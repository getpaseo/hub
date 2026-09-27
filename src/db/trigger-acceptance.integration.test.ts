import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPostgresQueryRuntime } from "./test-utils/runtime.js";
import { createDatabase } from "./test-utils/runtime.js";

describe("trigger acceptance persistence", () => {
  let postgres: StartedPostgreSqlContainer;
  let databaseUrl: string;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    databaseUrl = postgres.getConnectionUri();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  }, 120_000);

  it("does not resolve another organization when delivery keys collide", async () => {
    const database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);

    await client.query(`
      insert into organization (id, name, slug) values
        ('manual-org-a', 'Manual A', 'manual-a'),
        ('manual-org-b', 'Manual B', 'manual-b');
      insert into projects (id, organization_id, name, slug)
      values
        ('10000000-0000-4000-8000-000000000001', 'manual-org-a', 'Default', 'same-project'),
        ('20000000-0000-4000-8000-000000000001', 'manual-org-b', 'Default', 'same-project');
    `);
    await client.close();
    for (const [projectId, contentHash] of [
      ["10000000-0000-4000-8000-000000000001", "manual-org-a-config"],
      ["20000000-0000-4000-8000-000000000001", "manual-org-b-config"],
    ] as const) {
      const revision = await database.insertProjectConfigurationRevision({
        projectId,
        sourceKind: "manual",
        sourceEvidence: { kind: "test" },
        normalizedConfiguration: { environments: [], triggers: [] },
        contentHash,
      });
      await database.activateProjectConfigurationRevision(projectId, revision.id);
    }

    const first = await database.persistManualEvent(
      input("manual-org-a", "10000000-0000-4000-8000-000000000001"),
    );
    const second = await database.persistManualEvent(
      input("manual-org-b", "20000000-0000-4000-8000-000000000001"),
    );
    assert.equal(first.status, "accepted");
    assert.equal(second.status, "accepted");
    if (first.status !== "accepted" || second.status !== "accepted")
      throw new Error("expected accepted triggers");
    assert.notEqual(first.event.providerEventReceiptId, second.event.providerEventReceiptId);

    const duplicate = await database.persistManualEvent(
      input("manual-org-a", "10000000-0000-4000-8000-000000000001"),
    );
    assert.equal(duplicate.status, "accepted");
    if (duplicate.status !== "accepted") throw new Error("expected replayed accepted trigger");
    assert.equal(duplicate.event.providerEventReceiptId, first.event.providerEventReceiptId);
    assert.equal(duplicate.event.organizationId, "manual-org-a");
    assert.equal(duplicate.event.projectId, "10000000-0000-4000-8000-000000000001");
    await database.close();
  }, 120_000);

  it("lists only receipts with a committed bounded drop reason", async () => {
    const database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);

    await client.query(`
      insert into organization (id, name, slug)
      values ('drop-reason-org', 'Drop Reason', 'drop-reason');
      insert into projects (id, organization_id, name, slug)
      values ('30000000-0000-4000-8000-000000000001', 'drop-reason-org', 'Default', 'default');
    `);
    await client.close();
    const revision = await database.insertProjectConfigurationRevision({
      projectId: "30000000-0000-4000-8000-000000000001",
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "drop-reason-config",
    });
    await database.activateProjectConfigurationRevision(
      "30000000-0000-4000-8000-000000000001",
      revision.id,
    );
    const receipt = await database.persistManualEvent({
      organizationId: "drop-reason-org",
      projectId: "30000000-0000-4000-8000-000000000001",
      source: "manual.run",
      deliveryId: "drop-reason-delivery",
      receivedAt: new Date(),
      payload: { private: "PRIVATE-EVENT-BODY" },
    });
    if (receipt.status !== "accepted") throw new Error("expected accepted receipt");

    assert.deepEqual(
      await database.listUnroutedProviderEventsForOrganization("drop-reason-org"),
      [],
    );
    await database.markProviderEventDropped(
      receipt.event.providerEventReceiptId,
      "trigger_filters_rejected",
    );
    const [unrouted] = await database.listUnroutedProviderEventsForOrganization("drop-reason-org");
    assert.equal(unrouted?.droppedReason, "trigger_filters_rejected");
    assert.equal("payload" in (unrouted ?? {}), false);
    await database.close();
  }, 120_000);

  it("durably drops Linear events until the connection has the required scopes", async () => {
    const database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);
    const organizationId = "linear-scope-org";
    const projectId = "40000000-0000-4000-8000-000000000001";
    const connectionId = "40000000-0000-4000-8000-000000000002";

    await client.query(`
      insert into organization (id, name, slug)
      values ('${organizationId}', 'Linear Scope', 'linear-scope');
      insert into projects (id, organization_id, name, slug)
      values ('${projectId}', '${organizationId}', 'Default', 'default');
      insert into linear_connections
        (id, organization_id, linear_organization_id, provider_application_id, slug,
         linear_organization_name, app_user_id, access_token, refresh_token, scopes)
      values
        ('${connectionId}', '${organizationId}', 'linear-scope-workspace', 'linear-app',
         'linear-scope', 'Linear Scope', 'linear-app-user', 'linear-access-token',
         'linear-refresh-token', '["read"]'::jsonb);
    `);
    const revision = await database.insertProjectConfigurationRevision({
      projectId,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "linear-scope-config",
    });
    await database.activateProjectConfigurationRevision(projectId, revision.id, [
      {
        provider: "linear",
        connectionId,
        resourceId: "linear-project",
        triggerName: "linear-issue",
      },
    ]);

    const dropped = await database.acceptLinearEvent({
      linearOrganizationId: "linear-scope-workspace",
      projectId: "linear-project",
      deliveryId: "linear-under-scoped",
      source: "linear.issue",
      payload: {},
      receivedAt: new Date(0),
    });
    assert.equal(dropped.status, "dropped");
    if (dropped.status !== "dropped") throw new Error("expected an under-scoped drop");
    assert.equal(dropped.reason, "configuration_unavailable");
    assert.equal(
      (await database.findProviderEventReceiptByDeliveryId("linear-under-scoped", organizationId))
        ?.droppedReason,
      "configuration_unavailable",
    );

    await client.query(
      `update linear_connections set scopes = '["read", "comments:create"]'::jsonb
       where id = '${connectionId}'`,
    );
    const accepted = await database.acceptLinearEvent({
      linearOrganizationId: "linear-scope-workspace",
      projectId: "linear-project",
      deliveryId: "linear-reauthorized",
      source: "linear.issue",
      payload: {},
      receivedAt: new Date(1),
    });
    assert.equal(accepted.status, "accepted");
    if (accepted.status === "accepted") assert.equal(accepted.events[0]?.projectId, projectId);

    await client.query(
      `update linear_connections
       set refresh_token = null, access_token_expires_at = '1970-01-01T00:00:00.000Z'
       where id = '${connectionId}'`,
    );
    const expired = await database.acceptLinearEvent({
      linearOrganizationId: "linear-scope-workspace",
      projectId: "linear-project",
      deliveryId: "linear-expired-without-refresh",
      source: "linear.issue",
      payload: {},
      receivedAt: new Date(120_000),
    });
    assert.equal(expired.status, "dropped");
    if (expired.status !== "dropped") throw new Error("expected an expired-token drop");
    assert.equal(expired.reason, "configuration_unavailable");

    await client.close();
    await database.close();
  }, 120_000);
  it("keeps two instances hosting the same repository in their own organizations", async () => {
    const database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);
    const instances = [
      {
        organizationId: "forgejo-org-vogon",
        projectId: "50000000-0000-4000-8000-000000000001",
        connectionId: "50000000-0000-4000-8000-000000000011",
        host: "git.vogon.test",
      },
      {
        organizationId: "forgejo-org-magrathea",
        projectId: "50000000-0000-4000-8000-000000000002",
        connectionId: "50000000-0000-4000-8000-000000000012",
        host: "git.magrathea.test",
      },
    ] as const;

    for (const instance of instances) {
      await client.query(`
        insert into organization (id, name, slug)
        values ('${instance.organizationId}', '${instance.host}', '${instance.organizationId}');
        insert into projects (id, organization_id, name, slug)
        values ('${instance.projectId}', '${instance.organizationId}', 'Default', 'default');
        insert into forgejo_connections
          (id, organization_id, slug, instance_base_url, instance_host, webhook_secret,
           access_token, account_login, account_id, instance_flavor, instance_version)
        values
          ('${instance.connectionId}', '${instance.organizationId}', 'forge',
           'https://${instance.host}', '${instance.host}', 'hook-secret',
           'forgejo-access-token', 'trillian', 42, 'forgejo', '16.0.5+gitea-1.22.0');
      `);
      const revision = await database.insertProjectConfigurationRevision({
        projectId: instance.projectId,
        sourceKind: "manual",
        sourceEvidence: { kind: "test" },
        normalizedConfiguration: { environments: [], triggers: [] },
        contentHash: `${instance.organizationId}-config`,
      });
      await database.activateProjectConfigurationRevision(instance.projectId, revision.id, [
        {
          provider: "forgejo",
          connectionId: instance.connectionId,
          resourceId: "9001",
          triggerName: "forgejo-issue-comment",
        },
      ]);
    }

    for (const instance of instances) {
      const accepted = await database.acceptForgejoEvent({
        connectionId: instance.connectionId,
        repositoryId: 9001,
        deliveryId: `delivery-on-${instance.host}`,
        source: "forgejo.issue_comment",
        repo: "acme/widgets",
        payload: { repository: { id: 9001, full_name: "acme/widgets" } },
        receivedAt: new Date(0),
      });
      assert.equal(accepted.status, "accepted");
      if (accepted.status !== "accepted") throw new Error("expected an accepted delivery");
      assert.equal(accepted.events.length, 1);
      assert.equal(accepted.events[0]?.projectId, instance.projectId);
      assert.equal(accepted.events[0]?.organizationId, instance.organizationId);
    }

    const unbound = await database.acceptForgejoEvent({
      connectionId: "50000000-0000-4000-8000-0000000000ff",
      repositoryId: 9001,
      deliveryId: "delivery-from-nowhere",
      source: "forgejo.issue_comment",
      repo: "acme/widgets",
      payload: {},
      receivedAt: new Date(1),
    });
    assert.equal(unbound.status, "dropped");
    if (unbound.status !== "dropped") throw new Error("expected an unbound drop");
    assert.equal(unbound.reason, "forgejo_unbound");

    await client.close();
    await database.close();
  }, 120_000);
  it("gives a pasted-token connection a slug no other provider already holds", async () => {
    const database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);
    const organizationId = "forgejo-slug-org";
    const userId = "forgejo-slug-user";

    await client.query(`
      insert into organization (id, name, slug)
      values ('${organizationId}', 'Forgejo Slug', 'forgejo-slug');
      insert into "user" (id, name, email, email_verified)
      values ('${userId}', 'Trillian McMillan', 'trillian@example.test', true);
      insert into session (id, token, user_id, active_organization_id, expires_at)
      values ('forgejo-slug-session', 'forgejo-slug-token', '${userId}', '${organizationId}',
              now() + interval '1 hour');
      insert into member (id, organization_id, user_id, role)
      values ('forgejo-slug-membership', '${organizationId}', '${userId}', 'owner');
    `);
    const access = {
      sessionId: "forgejo-slug-session",
      userId,
      membershipId: "forgejo-slug-membership",
      organizationId,
      returnRoute: "/",
    };

    const first = await database.bindForgejoConnection({
      access,
      instanceBaseUrl: "https://git.vogon.test",
      instanceHost: "git.vogon.test",
      webhookSecret: "hook-secret-one",
      accessToken: "token-one",
      accountLogin: "trillian",
      accountId: 1,
      instanceFlavor: "forgejo",
      instanceVersion: "16.0.5+gitea-1.22.0",
    });
    const second = await database.bindForgejoConnection({
      access,
      instanceBaseUrl: "https://git.vogon.test",
      instanceHost: "git.vogon.test",
      webhookSecret: "hook-secret-two",
      accessToken: "token-two",
      accountLogin: "zaphod",
      accountId: 2,
      instanceFlavor: "forgejo",
      instanceVersion: "16.0.5+gitea-1.22.0",
    });

    assert.notEqual(first.id, second.id);
    assert.notEqual(first.slug, second.slug);
    assert.equal(first.accessToken, "token-one");
    assert.equal(first.organizationId, organizationId);

    const reloaded = await database.findForgejoConnection(second.id);
    assert.equal(reloaded?.webhookSecret, "hook-secret-two");
    assert.equal(reloaded?.accountLogin, "zaphod");

    const usage = await database.organizationConnectionUsage(organizationId);
    assert.deepEqual(
      usage.forgejo.map((connection) => connection.slug).sort(),
      [first.slug, second.slug].sort(),
    );

    await client.close();
    await database.close();
  }, 120_000);
});

function input(organizationId: string, projectId: string) {
  return {
    organizationId,
    projectId,
    source: "manual.run",
    deliveryId: "same-delivery-key",
    receivedAt: new Date(),
    payload: { authenticatedBy: { kind: "api-key", keyId: `key-${organizationId}` } },
  } as const;
}
