import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { createApplicationRuntime } from "../application-runtime.js";
import { createAuthServer, type AuthServer } from "../auth/server.js";
import { composeEntitlements } from "../auth/entitlements.js";
import { createDatabase } from "../db/pg.js";
import { EnrollmentTokenSchema, InstalledConfigurationSchema, ProblemSchema } from "./contracts.js";
import { loadBuiltStartServer, type BuiltStartServer } from "../server/build.js";

const builtServerTests = describe.runIf(process.env["RUN_BUILT_PUBLIC_API_TESTS"] === "1");

builtServerTests("built TanStack public API PostgreSQL contract", () => {
  let postgres: StartedPostgreSqlContainer;
  let auth: AuthServer;
  let built: BuiltStartServer;
  let databaseUrl: string;
  let secrets: Record<"organization-a" | "organization-b", string>;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    databaseUrl = postgres.getConnectionUri();
    const database = await createDatabase(databaseUrl);
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`
      insert into organization (id, name, slug) values
        ('organization-a', 'Organization A', 'organization-a'),
        ('organization-b', 'Organization B', 'organization-b');
      insert into "user" (id, name, email, email_verified) values
        ('user-a', 'Owner A', 'owner-a@example.test', true),
        ('user-b', 'Owner B', 'owner-b@example.test', true);
      insert into member (id, organization_id, user_id, role) values
        ('member-a', 'organization-a', 'user-a', 'owner'),
        ('member-b', 'organization-b', 'user-b', 'owner');
    `);
    await client.end();
    for (const [organizationId, userId] of [
      ["organization-a", "user-a"],
      ["organization-b", "user-b"],
    ] as const) {
      await database.createProject({
        organizationId,
        name: "Shared slug",
        slug: "same-project",
        createdByUserId: userId,
      });
    }
    const entitlements = composeEntitlements(database, databaseUrl);
    auth = createAuthServer({
      databaseUrl,
      entitlements: entitlements.service,
      secret: "built-public-api-test-secret".padEnd(32, "-"),
      baseURL: "http://hub.test",
      policy: {
        registrationMode: "open",
        organizationCreation: "disabled",
        bootstrap: undefined,
      },
    });
    const keyA = await auth.apiKeys!.create("organization-a", "user-a", "built A", [
      "configuration:install",
      "runs:dispatch",
      "daemons:enroll",
    ]);
    const keyB = await auth.apiKeys!.create("organization-b", "user-b", "built B", [
      "configuration:install",
      "runs:dispatch",
      "daemons:enroll",
    ]);
    secrets = { "organization-a": keyA.secret, "organization-b": keyB.secret };
    const runtime = await createApplicationRuntime({
      database,
      auth,
      entitlements: entitlements.service,
      publicApi: { status: "enabled", authenticator: auth.apiKeys! },
      async close() {
        await auth.close();
        await entitlements.close();
        await database.close();
      },
    });
    await runtime.hub.start();
    built = await loadBuiltStartServer();
    await built.startApplication(() => runtime);
  }, 120_000);

  afterAll(async () => {
    await built?.stopProductionRuntime();
    await postgres?.stop();
  }, 120_000);

  it("covers every canonical operation with isolated colliding tenants and persisted effects", async () => {
    for (const organizationId of ["organization-a", "organization-b"] as const) {
      const install = await post("/api/v1/configurations/install", secrets[organizationId], {
        projectSlug: "same-project",
        yaml: `project: file/${organizationId}-project\nenvironments:\n  - name: runner\n    kind: docker\n    image: paseo/valid\ntriggers: []`,
      });
      assert.equal(install.status, 201);
      const installed = InstalledConfigurationSchema.parse(await install.json());
      assert.equal(installed.projectSlug, "same-project");
      assert.match(installed.versionId, /^[0-9a-f-]{36}$/u);

      const manualBody = {
        projectSlug: "same-project",
        trigger: "not-configured",
        actor: "automation",
        deliveryKey: "shared-delivery-key",
        input: { organizationId },
      };
      const first = await post("/api/v1/manual-runs", secrets[organizationId], manualBody);
      assert.equal(first.status, 404);
      assert.equal(ProblemSchema.parse(await first.json()).code, "trigger_not_found");
      const duplicate = await post("/api/v1/manual-runs", secrets[organizationId], manualBody);
      assert.equal(duplicate.status, 404);
      assert.equal(ProblemSchema.parse(await duplicate.json()).code, "trigger_not_found");

      const enrollment = await post("/api/v1/daemons/enrollment-tokens", secrets[organizationId]);
      assert.equal(enrollment.status, 201);
      assert.equal(typeof EnrollmentTokenSchema.parse(await enrollment.json()).token, "string");
    }

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const revisions = await client.query<{ organization_id: string; project_slug: string }>(`
      select revision.organization_id, project.slug as project_slug
      from project_configuration_revisions revision
      join projects project on project.id = revision.project_id
      order by revision.organization_id
    `);
    const receipts = await client.query<{
      organization_id: string;
      project_organization_id: string;
      public_delivery_key: string;
    }>(`
      select receipt.organization_id, project.organization_id as project_organization_id,
             receipt.payload->>'publicDeliveryKey' as public_delivery_key
      from provider_event_receipts receipt
      join projects project on project.id = (receipt.accepted_routes->0->>'projectId')::uuid
      where receipt.provider = 'manual'
        and receipt.payload->>'publicDeliveryKey' = 'shared-delivery-key'
      order by receipt.organization_id
    `);
    const enrollments = await client.query<{ organization_id: string; count: string }>(`
      select organization_id, count(*)::text as count
      from daemon_enrollment_tokens group by organization_id order by organization_id
    `);
    await client.end();
    assert.deepEqual(revisions.rows, [
      { organization_id: "organization-a", project_slug: "same-project" },
      { organization_id: "organization-b", project_slug: "same-project" },
    ]);
    assert.deepEqual(receipts.rows, [
      {
        organization_id: "organization-a",
        project_organization_id: "organization-a",
        public_delivery_key: "shared-delivery-key",
      },
      {
        organization_id: "organization-b",
        project_organization_id: "organization-b",
        public_delivery_key: "shared-delivery-key",
      },
    ]);
    assert.deepEqual(enrollments.rows, [
      { organization_id: "organization-a", count: "1" },
      { organization_id: "organization-b", count: "1" },
    ]);
  }, 120_000);

  it("contains unexpected PostgreSQL details behind the canonical internal-error boundary", async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("alter table projects rename to projects_unavailable_for_boundary_test");
    await client.end();

    const response = await post("/api/v1/configurations/install", secrets["organization-a"], {
      projectSlug: "same-project",
      yaml: "environments:\n  - name: runner\n    kind: docker\n    image: paseo/valid\ntriggers: []",
    });
    assert.equal(response.status, 500);
    const serialized = JSON.stringify(await response.json());
    assert.equal(ProblemSchema.parse(JSON.parse(serialized)).code, "internal_error");
    assert.equal(serialized.includes("projects_unavailable_for_boundary_test"), false);
    assert.equal(serialized.includes("relation"), false);
    assert.equal(serialized.includes("42P01"), false);
  }, 120_000);

  async function post(path: string, secret: string, body?: unknown): Promise<Response> {
    return built.default.fetch(
      new Request(`http://hub.test${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
});
