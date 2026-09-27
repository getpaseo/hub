import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase, createPostgresQueryRuntime } from "../../db/test-utils/runtime.js";
import type { Database, DurableProviderEvent } from "../../db/types.js";
import type { ForgejoTimelineEntry } from "../../providers/forgejo/client.js";
import { createForgejoWebhookSource } from "./webhook.js";

const ORGANIZATION_ID = "forgejo-pool-org";
const PROJECT_ID = "80000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "80000000-0000-4000-8000-000000000011";
const SECRET = "so-long-and-thanks-for-all-the-fish";
// more than pg's default pool of 10, to catch a delivery pinning a connection while
// waiting on Forgejo.
const SLOW_DELIVERIES = 12;

describe("Forgejo enrichment against a slow instance, on Postgres", () => {
  let postgres: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);
    await client.query(`
      insert into organization (id, name, slug)
      values ('${ORGANIZATION_ID}', 'Forgejo Pool', '${ORGANIZATION_ID}');
      insert into projects (id, organization_id, name, slug)
      values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Default', 'default');
      insert into forgejo_connections
        (id, organization_id, slug, instance_base_url, instance_host, webhook_secret,
         access_token, account_login, account_id, instance_flavor, instance_version)
      values
        ('${CONNECTION_ID}', '${ORGANIZATION_ID}', 'forge', 'https://git.example.test',
         'git.example.test', '${SECRET}', 'forgejo-access-token', 'trillian', 42,
         'forgejo', '16.0.5+gitea-1.22.0');
    `);
    await client.close();
    const revision = await database.insertProjectConfigurationRevision({
      projectId: PROJECT_ID,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "forgejo-pool-config",
    });
    await database.activateProjectConfigurationRevision(PROJECT_ID, revision.id, [
      {
        provider: "forgejo",
        connectionId: CONNECTION_ID,
        resourceId: "9001",
        triggerName: "forgejo-issue-comment",
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await postgres.stop();
  }, 120_000);

  it("keeps the pool free while more deliveries than it has connections wait on Forgejo", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = 0;
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = createForgejoWebhookSource({
      findConnection: async (id) => {
        const connection = await database.findForgejoConnection(id);
        return connection === undefined
          ? undefined
          : {
              id,
              webhookSecret: SECRET,
              accountId: connection.accountId,
              credentials: {
                instanceBaseUrl: connection.instanceBaseUrl,
                accessToken: connection.accessToken,
              },
            };
      },
      accept: (input) => database.acceptForgejoEvent(input),
      completeEnrichment: (receiptId, payload) =>
        database.completeForgejoEnrichment(receiptId, payload),
      credentialsForConnection: () =>
        Promise.resolve({ instanceBaseUrl: "https://git.example.test", accessToken: "tok" }),
      timelineClient: {
        listIssueTimeline: async () => {
          waiting += 1;
          await gate;
          return [labelEntry()];
        },
      },
      claimTimelineEntries: (connectionId, ids, receiptId) =>
        database.claimForgejoTimelineEntries(connectionId, ids, receiptId),
      enrichmentDeadlineMs: 60_000, // clear of the gate, this test is about the pool
    });
    await endpoint.start((event) => {
      dispatched.push(event);
      return Promise.resolve();
    });

    const slow = Array.from({ length: SLOW_DELIVERIES }, (_, index) =>
      endpoint.handle(labelUpdatedRequest(index + 1)),
    );
    await vi.waitFor(
      () => {
        if (waiting < SLOW_DELIVERIES) throw new Error(`only ${waiting} are enriching yet`);
      },
      { timeout: 10_000 },
    );

    // every delivery is parked on the instance now; the pool must still answer quickly
    // for anyone else.
    const started = Date.now();
    const lookups = await Promise.all(
      Array.from({ length: SLOW_DELIVERIES }, () => database.findForgejoConnection(CONNECTION_ID)),
    );
    assert.equal(lookups.filter((found) => found !== undefined).length, SLOW_DELIVERIES);
    assert.ok(Date.now() - started < 2_000, "pool queries should not wait on enrichment");

    // a duplicate of a parked delivery answers 200 without dispatching anything, since
    // its owner is still inside its enrichment budget.
    const duplicate = await endpoint.handle(labelUpdatedRequest(1, "delivery-duplicate"));
    assert.equal(duplicate.status, 200);
    assert.equal(dispatched.length, 0);

    release();
    const responses = await Promise.all(slow);
    assert.deepEqual(
      responses.map((response) => response.status),
      Array.from({ length: SLOW_DELIVERIES }, () => 200),
    );
    assert.equal(dispatched.length, SLOW_DELIVERIES);
  }, 120_000);
});

function labelEntry(): ForgejoTimelineEntry {
  return {
    id: 501,
    type: "label",
    body: "1",
    createdAtMs: Date.now(),
    userLogin: "zaphod",
    labelName: "bug",
    assigneeLogin: undefined,
    removedAssignee: false,
  };
}

/** One issue per delivery, so each has its own body and signature. */
function labelUpdatedRequest(issueNumber: number, deliveryId = `delivery-${issueNumber}`): Request {
  const body = JSON.stringify({
    action: "label_updated",
    repository: { id: 9001, full_name: "acme/widgets" },
    issue: { number: issueNumber, labels: [{ name: "bug" }] },
    sender: { login: "zaphod" },
  });
  const signature = createHmac("sha256", SECRET).update(body).digest("hex");
  return new Request(`https://hub.example.test/api/integrations/forgejo/events/${CONNECTION_ID}`, {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "X-Forgejo-Event": "issues",
      "X-Forgejo-Delivery": deliveryId,
      "X-Hub-Signature-256": `sha256=${signature}`,
    }),
    body,
  });
}
