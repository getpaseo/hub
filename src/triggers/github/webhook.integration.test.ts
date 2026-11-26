import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApplicationRuntime } from "../../application-runtime.js";
import { PostgresOutage } from "../../db/test-utils/outage.js";
import { createPostgresTestRuntime } from "../../db/test-utils/runtime.js";
import { UNLIMITED_TEMPLATE } from "../../entitlements/catalog.js";
import { EntitlementsService } from "../../entitlements/service.js";
import { createMemoryInboundQueue, type InboundQueue } from "../../inbound/index.js";
import { createLogger } from "../../logger.js";
import { createGitHubRegistration } from "../../providers/github/index.js";
import type { ApplicationRuntime } from "../../server/runtime.js";
import { acceptingAgentValidator } from "../../test-utils/agent-validator.js";
import { FailureLogStream } from "../../test-utils/failure-logs.js";
import { OrganizationTriggerStore } from "../store.js";
import type { GitHubReactionClient } from "./provider.js";

const SECRET = "github-webhook-secret";
const ORGANIZATION_ID = "github-org";

let server: StartedPostgreSqlContainer;

beforeAll(async () => {
  server = await new PostgreSqlContainer("postgres:17-alpine").start();
}, 120_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

describe("GitHub webhooks while Postgres is unavailable", () => {
  const hubs: GitHubHub[] = [];
  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  }, 60_000);

  async function startHub(): Promise<GitHubHub> {
    const hub = await GitHubHub.start(server);
    hubs.push(hub);
    return hub;
  }

  it("answers 200 during an outage and runs the trigger once Postgres is back", async () => {
    const hub = await startHub();

    await hub.outage.begin();
    try {
      expect(await hub.deliver("outage-delivery")).toBe(200);
      // GitHub redelivers by hand from the App's Advanced tab; the held copy absorbs it.
      expect(await hub.deliver("outage-delivery")).toBe(200);
      await hub.until(() => hub.health().inbound.retrying >= 1);
      expect(hub.health()).toMatchObject({
        ok: true,
        inbound: { queued: 0, inFlight: 0, retrying: 1 },
      });
      expect(hub.health().inbound.oldestAgeMs).toBeGreaterThanOrEqual(0);
    } finally {
      await hub.outage.end();
    }
    await hub.inbound.idle();

    expect(await hub.evidence("outage-delivery")).toEqual({ receipts: 1, runs: 1 });
    await hub.until(() => hub.reactions.length >= 1);
    await delay(300);
    expect(hub.reactions).toEqual(["eyes"]);
    expect(hub.health().inbound.totals).toMatchObject({ processed: 1, abandoned: 0 });
  }, 60_000);

  it("waits out a statement stall and records the delivery once", async () => {
    const hub = await startHub();

    const stall = await hub.outage.stall("provider_event_receipts");
    try {
      expect(await hub.deliver("stalled-delivery")).toBe(200);
      // The statement timeout is 3 seconds, so the first attempt fails while the lock is held.
      await hub.until(() => hub.health().inbound.totals.retried >= 1, 10_000);
    } finally {
      await stall.release();
    }
    await hub.inbound.idle();

    expect(await hub.evidence("stalled-delivery")).toEqual({ receipts: 1, runs: 1 });
    await hub.until(() => hub.reactions.length >= 1);
    expect(hub.reactions).toEqual(["eyes"]);
  }, 60_000);

  it("finishes an accepted delivery before closing the database on shutdown", async () => {
    const hub = await startHub();

    expect(await hub.deliver("shutdown-delivery")).toBe(200);
    await hub.stop();

    expect(await hub.evidenceAfterStop("shutdown-delivery")).toEqual({ receipts: 1, runs: 1 });
  }, 60_000);

  it("logs the delivery id of an event left unprocessed at the shutdown deadline", async () => {
    const hub = await startHub();

    await hub.outage.begin();
    try {
      expect(await hub.deliver("unfinished-delivery")).toBe(200);
      await hub.until(() => hub.health().inbound.retrying >= 1);
      const { unprocessed } = await hub.inbound.stop({ deadlineMs: 200 });
      expect(unprocessed).toEqual([{ kind: "github.webhook", id: "github:unfinished-delivery" }]);
      expect(hub.logRecord("inbound.unprocessed_on_shutdown")).toMatchObject({
        events: [{ kind: "github.webhook", id: "github:unfinished-delivery" }],
      });
    } finally {
      await hub.outage.end();
    }
  }, 60_000);
});

class GitHubHub {
  private stopped = false;

  private constructor(
    readonly reactions: readonly string[],
    private readonly storage: Awaited<ReturnType<typeof createPostgresTestRuntime>>,
    readonly outage: PostgresOutage,
    readonly inbound: InboundQueue,
    private readonly application: ApplicationRuntime,
    private readonly connectionString: string,
    private readonly logs: FailureLogStream,
  ) {}

  static async start(postgres: StartedPostgreSqlContainer): Promise<GitHubHub> {
    const connectionString = await createDatabase(postgres);
    const storage = await createPostgresTestRuntime(connectionString);
    const { database, runtime } = storage;
    await runtime.query("insert into organization (id, name, slug) values ($1, 'GitHub', 'gh')", [
      ORGANIZATION_ID,
    ]);
    const entitlements = new EntitlementsService(database, { seats: async () => 0 });
    await entitlements.stamp(ORGANIZATION_ID, UNLIMITED_TEMPLATE, {
      source: "provisioning",
      planId: null,
    });
    await enrollDaemon(storage.database);
    await runtime.query(
      `insert into github_connections
         (organization_id, installation_id, slug, account_id, account_login, account_type, status)
       values ($1, 42, 'acme-github', 'acme', 'acme', 'Organization', 'active')`,
      [ORGANIZATION_ID],
    );
    await new OrganizationTriggerStore(database, ORGANIZATION_ID, acceptingAgentValidator()).save({
      yaml: githubTriggerYaml,
      userId: null,
    });

    const logs = new FailureLogStream();
    const inbound = createMemoryInboundQueue({
      retry: { initialMs: 100, maxMs: 500 },
      logger: createLogger(logs),
    });
    const reactions: string[] = [];
    const reactionClient: GitHubReactionClient = {
      async createReaction(input) {
        reactions.push(input.content);
        return { id: reactions.length };
      },
      async deleteReaction() {},
    };
    const registration = createGitHubRegistration({
      database,
      auth: null,
      applicationBaseUrl: "http://hub.test",
      publicBaseUrl: "http://hub.test",
      configuration: {
        appId: "42",
        appSlug: "paseo",
        clientId: "client",
        clientSecret: "client-secret",
        privateKey: "unused-private-key",
        webhookSecret: SECRET,
      },
      inbound,
      reactionClient,
    });
    const application = await createApplicationRuntime({
      database,
      auth: null,
      entitlements,
      billing: null,
      registrations: [registration],
      inbound,
      publicBaseUrl: "http://hub.test",
      completionTokenSecret: "completion-secret",
      close: () => storage.runtime.close(),
    });
    const outage = await PostgresOutage.connect(connectionString);
    return new GitHubHub(reactions, storage, outage, inbound, application, connectionString, logs);
  }

  async deliver(deliveryId: string): Promise<number> {
    const body = JSON.stringify(issueCommentPayload());
    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const response = await this.application.webhook(
      new Request("http://hub.test/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": deliveryId,
          "x-github-event": "issue_comment",
          "x-hub-signature-256": signature,
        },
        body,
      }),
    );
    return response.status;
  }

  health() {
    return this.application.health();
  }

  evidence(deliveryId: string): Promise<{ receipts: number; runs: number }> {
    return countEvidence(this.storage.runtime, deliveryId);
  }

  async evidenceAfterStop(deliveryId: string): Promise<{ receipts: number; runs: number }> {
    const storage = await createPostgresTestRuntime(this.connectionString);
    try {
      return await countEvidence(storage.runtime, deliveryId);
    } finally {
      await storage.runtime.close();
    }
  }

  logRecord(message: string): Record<string, unknown> {
    const record = this.logs.records().find((candidate) => candidate["msg"] === message);
    if (record === undefined) throw new Error(`no ${message} log`);
    return record;
  }

  async until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await delay(20);
    expect(condition()).toBe(true);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.application.stop();
  }

  async close(): Promise<void> {
    await this.outage.end();
    await this.outage.close();
    await this.stop();
  }
}

async function countEvidence(
  runtime: Awaited<ReturnType<typeof createPostgresTestRuntime>>["runtime"],
  deliveryId: string,
): Promise<{ receipts: number; runs: number }> {
  const { rows } = await runtime.query<{ receipts: number; runs: number }>(
    `select
       (select count(*)::integer from provider_event_receipts where delivery_id = $1) as receipts,
       (select count(*)::integer from trigger_runs run
          join provider_event_receipts receipt on receipt.id = run.provider_event_receipt_id
          where receipt.delivery_id = $1) as runs`,
    [deliveryId],
  );
  return rows[0]!;
}

/** Each test gets its own database on the shared server, so an outage stays inside one test. */
async function createDatabase(postgres: StartedPostgreSqlContainer): Promise<string> {
  const url = new URL(postgres.getConnectionUri());
  url.pathname = `/github_${randomUUID().replaceAll("-", "")}`;
  return url.toString();
}

async function enrollDaemon(
  database: Awaited<ReturnType<typeof createPostgresTestRuntime>>["database"],
): Promise<void> {
  await database.issueEnrollmentToken({
    id: randomUUID(),
    verifier: "github-enrollment",
    organizationId: ORGANIZATION_ID,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
  });
  await database.enrollDaemon({
    daemonId: randomUUID(),
    idempotencyKey: randomUUID(),
    suggestedSlug: "devbox",
    tokenVerifier: "github-enrollment",
    serverId: randomUUID(),
    daemonPublicKey: "public",
    credentialVerifier: "credential",
    permissions: ["hub.execute"],
    now: new Date(),
  });
}

function issueCommentPayload() {
  return {
    action: "created",
    installation: { id: 42 },
    repository: { id: 9001, full_name: "acme/widgets" },
    sender: { login: "alice" },
    issue: { number: 7, title: "Widgets break", user: { login: "alice" } },
    comment: { id: 555, body: "@paseo please review", user: { login: "alice" } },
  };
}

const githubTriggerYaml = `name: github-review
on:
  github.issue_comment:
    connection: acme-github
    filters:
      from_users: [alice]
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Review the comment.
`;
