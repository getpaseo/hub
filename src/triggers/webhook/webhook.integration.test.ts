import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHubApplication } from "../../app.js";
import { PostgresOutage } from "../../db/test-utils/outage.js";
import { createPostgresTestRuntime } from "../../db/test-utils/runtime.js";
import { UNLIMITED_TEMPLATE } from "../../entitlements/catalog.js";
import { EntitlementsService } from "../../entitlements/service.js";
import { acceptingAgentValidator } from "../../test-utils/agent-validator.js";
import { OrganizationTriggerStore } from "../store.js";
import { webhookYaml } from "./test-fixture.js";

let fixture: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
  fixture = await setup();
}, 120_000);

afterAll(async () => {
  await fixture?.close();
}, 120_000);

it("authorizes, deduplicates, meters and queues durable webhook work across redeploys and rotation", async () => {
  const { app, database, store, entitlements, runtime } = fixture;
  const { trigger, initialWebhookSecret } = await store.save({ yaml: webhookYaml, userId: null });
  const [endpoint] = await database.webhooks.list("webhook-org");
  expect(endpoint).toMatchObject({ triggerId: trigger.id, hasSecret: true });
  expect(endpoint!.endpointId).toMatch(/^wh_[\w-]{32}$/u);
  expect(initialWebhookSecret).toMatch(/^whsec_[\w-]{43}$/u);
  const endpointId = endpoint!.endpointId;
  const storedHash = async () =>
    (
      await runtime.query<{ secret_hash: string | null }>(
        "select secret_hash from trigger_webhooks where trigger_id = $1",
        [trigger.id],
      )
    ).rows[0]!.secret_hash;
  const sha256 = (secret: string) => createHash("sha256").update(secret).digest("hex");
  expect(await storedHash()).toBe(sha256(initialWebhookSecret!));
  expect(await database.webhooks.authenticate(endpointId, initialWebhookSecret!)).toBe(
    "webhook-org",
  );
  expect(await database.webhooks.rotate("different-org", trigger.id)).toBeUndefined();
  expect(await database.webhooks.rotate("webhook-org", trigger.id, "create")).toBeUndefined();
  // A row from before secrets were generated on creation is the only one "create" still fills.
  await runtime.query("update trigger_webhooks set secret_hash = null where trigger_id = $1", [
    trigger.id,
  ]);
  const first = (await database.webhooks.rotate("webhook-org", trigger.id, "create"))!;
  expect(await database.webhooks.rotate("webhook-org", trigger.id, "create")).toBeUndefined();
  expect(await storedHash()).toBe(sha256(first.secret));

  const payload = '{"alert":"disk full","note":"${{ paseo.prompt }}"}';
  const post = (
    token?: string,
    body = payload,
    key?: string,
    { id = endpointId, contentType = "application/json" } = {},
  ) =>
    app.operations.handleWebhookDelivery(
      new Request(`http://localhost/webhooks/${id}`, {
        method: "POST",
        headers: {
          "content-type": contentType,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        body,
      }),
      id,
    );

  const missing = await post();
  const wrong = await post(`whsec_${"x".repeat(43)}`);
  const unknown = await post(first.secret, payload, undefined, { id: `wh_${"x".repeat(32)}` });
  expect([missing.status, wrong.status, unknown.status]).toEqual([401, 401, 401]);
  expect(await wrong.text()).toBe(await unknown.text());
  expect((await post(first.secret, "x".repeat(32 * 1024 + 1))).status).toBe(413);
  expect((await post(first.secret, "{broken")).status).toBe(400);
  const nul = await post(first.secret, "before\u0000after", undefined, {
    contentType: "text/plain",
  });
  expect(nul.status).toBe(400);

  const [delivery, retry] = await Promise.all([
    post(first.secret, payload, "alert-1"),
    post(first.secret, payload, "alert-1"),
  ]);
  expect([delivery.status, retry.status]).toEqual([202, 202]);
  const receipt = z
    .object({ runId: z.string().uuid(), status: z.literal("accepted") })
    .parse(await delivery.json());
  expect(await retry.json()).toEqual(receipt);
  const run = await database.findTriggerRunById(receipt.runId);
  expect(run).toMatchObject({ outcome: "accepted", configuredTriggerName: "alert-handler" });
  expect(run?.outcome === "accepted" && run.prompt).toContain("untrusted external webhook data");
  expect(await database.listWorkflowStepRunsForTriggerRun(receipt.runId)).toHaveLength(1);
  const evidence = await database.findProviderEventReceiptById(run!.providerEventReceiptId);
  expect(evidence).toMatchObject({
    provider: "webhook",
    source: "webhook.received",
    payload: {
      body: payload,
      contentType: "application/json",
      receivedAt: evidence?.receivedAt.toISOString(),
    },
  });
  expect((await runtime.query("select run.* from workflow_wakeups run")).rows).toHaveLength(1);

  const edited = await store.save({
    triggerId: trigger.id,
    yaml: webhookYaml.replace("Summarize", "Inspect"),
    userId: null,
  });
  expect(edited.initialWebhookSecret).toBeUndefined();
  expect(await database.webhooks.list("webhook-org")).toEqual([endpoint]);
  expect(await storedHash()).toBe(sha256(first.secret));
  expect(
    (await post(first.secret, "plain text alert", undefined, { contentType: "text/plain" })).status,
  ).toBe(202);

  const rotated = (await database.webhooks.rotate("webhook-org", trigger.id))!;
  expect(rotated.endpointId).toBe(endpointId);
  expect((await post(first.secret)).status).toBe(401);
  expect((await post(rotated.secret)).status).toBe(202);

  await entitlements.override(
    "webhook-org",
    { meters: { "executions.monthly": { limit: 1 } } },
    null,
    "test cap",
  );
  await entitlements.consume("webhook-org", "executions.monthly", 1);
  expect((await post(rotated.secret)).status).toBe(403);
  expect(await (await post(rotated.secret, payload, "alert-1")).json()).toEqual(receipt);

  await entitlements.clearOverride("webhook-org", "executions.monthly", null, "reset test cap");
  for (let attempt = 3; attempt < 60; attempt++) {
    expect((await post(rotated.secret)).status).toBe(202);
  }
  expect((await post(rotated.secret)).status).toBe(429);
  expect(await (await post(rotated.secret, payload, "alert-1")).json()).toEqual(receipt);
  await store.save({ triggerId: trigger.id, yaml: `enabled: false\n${webhookYaml}`, userId: null });
  expect((await post(rotated.secret)).status).toBe(409);
});

it("answers 503 with Retry-After while Postgres is unavailable", async () => {
  const { app, store, connectionString } = fixture;
  const { trigger, initialWebhookSecret } = await store.save({
    yaml: webhookYaml.replace("alert-handler", "outage-handler"),
    userId: null,
  });
  const endpoint = (await fixture.database.webhooks.list("webhook-org")).find(
    (candidate) => candidate.triggerId === trigger.id,
  );
  const post = () =>
    app.operations.handleWebhookDelivery(
      new Request(`http://localhost/webhooks/${endpoint!.endpointId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${initialWebhookSecret!}`,
        },
        body: '{"alert":"disk full"}',
      }),
      endpoint!.endpointId,
    );

  const outage = await PostgresOutage.connect(connectionString);
  try {
    await outage.begin();
    const unavailable = await post();
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("30");
    expect(await unavailable.json()).toEqual({ error: "database_unavailable" });
  } finally {
    await outage.end();
    await outage.close();
  }
  expect((await post()).status).toBe(202);
}, 60_000);

async function setup() {
  const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  let runtime: Awaited<ReturnType<typeof createPostgresTestRuntime>>["runtime"] | undefined;
  try {
    const storage = await createPostgresTestRuntime(postgres.getConnectionUri());
    runtime = storage.runtime;
    const { database } = storage;
    await runtime.query(
      "insert into organization (id, name, slug) values ('webhook-org', 'Webhook', 'webhook')",
    );
    const entitlements = new EntitlementsService(database, { seats: async () => 0 });
    await entitlements.stamp("webhook-org", UNLIMITED_TEMPLATE, {
      source: "provisioning",
      planId: null,
    });
    await database.issueEnrollmentToken({
      id: randomUUID(),
      verifier: "test-webhook-enrollment",
      organizationId: "webhook-org",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    await database.enrollDaemon({
      daemonId: randomUUID(),
      idempotencyKey: randomUUID(),
      suggestedSlug: "devbox",
      tokenVerifier: "test-webhook-enrollment",
      serverId: randomUUID(),
      daemonPublicKey: "public",
      credentialVerifier: "credential",
      permissions: ["hub.execute"],
      now: new Date(),
    });
    const app = createHubApplication({
      database,
      entitlements,
      publicApi: { status: "unavailable" },
    });
    const store = new OrganizationTriggerStore(database, "webhook-org", acceptingAgentValidator());
    return {
      app,
      store,
      connectionString: postgres.getConnectionUri(),
      runtime,
      database,
      entitlements,
      async close() {
        try {
          await app.hub.stop();
          await storage.runtime.close();
        } finally {
          await postgres.stop();
        }
      },
    };
  } catch (error) {
    await runtime?.close();
    await postgres.stop();
    throw error;
  }
}
