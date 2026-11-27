import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { WebSocket } from "ws";
import { ActiveDaemonRegistry, createDaemonUpgradeHandler } from "../daemons/registry.js";
import { ReceiptRetention } from "../receipt-retention/index.js";
import { createDatabase } from "./pg.js";
import { postgresDatabaseRuntime } from "./runtime/index.js";

const GITHUB_OWNER = { providerApplicationId: "42", configurationVersion: 0 };

function databaseUrl(postgres: StartedPostgreSqlContainer, name: string): string {
  const url = new URL(postgres.getConnectionUri());
  url.pathname = `/${name}`;
  return url.toString();
}

async function connectLegacyDaemon(
  port: number,
  daemonId: string,
  secret: string,
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/daemons/socket`, {
    headers: {
      authorization: `Bearer ${secret}`,
      "x-paseo-daemon-id": daemonId,
    },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

async function waitForCondition(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe("zero-downtime two-machine overlap on Postgres", () => {
  let postgres: StartedPostgreSqlContainer;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  }, 120_000);

  it("serializes concurrent PostgresRuntime.migrate() calls without DDL collision", async () => {
    const url = databaseUrl(postgres, "concurrent_migrate_test");
    const first = await postgresDatabaseRuntime(url);
    const second = await postgresDatabaseRuntime(url);
    try {
      await Promise.all([first.runtime.migrate(), second.runtime.migrate()]);
      const tables = await first.runtime.query<{ count: number }>(
        `select count(*)::int as count from information_schema.tables where table_schema = 'public' and table_name = 'daemons'`,
      );
      assert.equal(tables.rows[0]?.count, 1);
    } finally {
      await Promise.allSettled([first.runtime.close(), second.runtime.close()]);
    }
  }, 120_000);

  it("waits past the 3s pool statement_timeout when another session holds the migration lock", async () => {
    const url = databaseUrl(postgres, "migrate_no_timeout_test");
    const { runtime } = await postgresDatabaseRuntime(url);
    const holder = new Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query(`select pg_advisory_lock(hashtextextended('paseo-hub:migrations', 0))`);
      let finished = false;
      const migrating = (async () => {
        await runtime.migrate();
        finished = true;
      })();
      // Hold longer than the 3s pool statement_timeout; migrate() must not abort with 57014.
      await delay(3_500);
      assert.equal(finished, false);
      await holder.query(`select pg_advisory_unlock(hashtextextended('paseo-hub:migrations', 0))`);
      await migrating;
      assert.equal(finished, true);
    } finally {
      await holder.end().catch(() => undefined);
      await runtime.close();
    }
  }, 120_000);

  it("fences daemon offline presence by connection_id across two machines", async () => {
    const url = databaseUrl(postgres, "fenced_presence_test");
    const machineA = await postgresDatabaseRuntime(url);
    await machineA.runtime.migrate();
    const machineB = await postgresDatabaseRuntime(url);
    const dbA = createDatabase(machineA.runtime, machineA.locks);
    const dbB = createDatabase(machineB.runtime, machineB.locks);
    const registryA = new ActiveDaemonRegistry(dbA);
    const registryB = new ActiveDaemonRegistry(dbB);
    const serverA = createServer();
    const serverB = createServer();
    const upgradeA = createDaemonUpgradeHandler(dbA, registryA);
    const upgradeB = createDaemonUpgradeHandler(dbB, registryB);
    serverA.on("upgrade", (req, socket, head) => void upgradeA(req, socket, head));
    serverB.on("upgrade", (req, socket, head) => void upgradeB(req, socket, head));
    await new Promise<void>((resolve) => serverA.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => serverB.listen(0, "127.0.0.1", resolve));

    let socketA: WebSocket | undefined;
    let socketB: WebSocket | undefined;
    try {
      const addrA = serverA.address();
      const addrB = serverB.address();
      assert.ok(addrA && typeof addrA !== "string");
      assert.ok(addrB && typeof addrB !== "string");

      await machineA.runtime.query(
        `insert into organization (id, name, slug) values ('org-fence', 'Fence Org', 'org-fence')`,
      );
      const token = "enroll-token-fence";
      const tokenVerifier = createHash("sha256").update(token).digest("base64url");
      await dbA.issueEnrollmentToken({
        id: randomUUID(),
        verifier: tokenVerifier,
        organizationId: "org-fence",
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      });
      const secret = "daemon-secret-fence";
      const daemonId = randomUUID();
      const enrolled = await dbA.enrollDaemon({
        daemonId,
        idempotencyKey: "fence-idem",
        serverId: "server-fence",
        daemonPublicKey: "pub-fence",
        credentialVerifier: createHash("sha256").update(secret).digest("base64url"),
        suggestedSlug: "fence-daemon",
        permissions: ["hub.execute"],
        tokenVerifier,
        now: new Date(),
      });
      assert.ok(enrolled && "id" in enrolled);

      // Machine A accepts conn-1
      socketA = await connectLegacyDaemon(addrA.port, daemonId, secret);
      await waitForCondition(async () => {
        const daemon = await dbA.findDaemonById(daemonId);
        return daemon?.presence === "connected" && daemon.connectionId !== null;
      }, "Machine A connected presence");
      const conn1 = (await dbA.findDaemonById(daemonId))!.connectionId!;

      // Daemon reconnects to Machine B (conn-2) while conn-1 is still open on Machine A
      socketB = await connectLegacyDaemon(addrB.port, daemonId, secret);
      await waitForCondition(async () => {
        const daemon = await dbB.findDaemonById(daemonId);
        return (
          daemon?.presence === "connected" &&
          daemon.connectionId !== null &&
          daemon.connectionId !== conn1
        );
      }, "Machine B connected presence");
      const conn2 = (await dbB.findDaemonById(daemonId))!.connectionId!;

      // Machine A's socket closes AFTER Machine B took over
      const closedA = new Promise<void>((resolve) => socketA!.once("close", () => resolve()));
      socketA.close();
      await closedA;
      await registryA.stop();

      const afterAClose = await dbB.findDaemonById(daemonId);
      assert.equal(afterAClose?.presence, "connected");
      assert.equal(afterAClose?.connectionId, conn2);

      // When Machine B's socket closes, the owning connection_id matches and flips to offline.
      const closedB = new Promise<void>((resolve) => socketB!.once("close", () => resolve()));
      socketB.close();
      await closedB;
      await registryB.stop();

      const afterBClose = await dbB.findDaemonById(daemonId);
      assert.equal(afterBClose?.presence, "offline");
      assert.equal(afterBClose?.connectionId, null);
    } finally {
      socketA?.terminate();
      socketB?.terminate();
      await registryA.stop();
      await registryB.stop();
      await new Promise<void>((resolve) => serverA.close(() => resolve()));
      await new Promise<void>((resolve) => serverB.close(() => resolve()));
      await Promise.allSettled([machineA.runtime.close(), machineB.runtime.close()]);
    }
  }, 120_000);

  it("skips overlapping ReceiptRetention.runBatch() sweeps cleanly via non-blocking advisory lock", async () => {
    const url = databaseUrl(postgres, "receipt_retention_overlap_test");
    const machineA = await postgresDatabaseRuntime(url);
    await machineA.runtime.migrate();
    const machineB = await postgresDatabaseRuntime(url);
    const holder = new Client({ connectionString: url });
    await holder.connect();
    try {
      await machineA.runtime.query(
        `insert into organization (id, name, slug) values ('org-ret', 'Ret Org', 'org-ret')`,
      );
      await machineA.runtime.query(
        `insert into provider_event_receipts
           (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
         values ('org-ret', 'github', 'expired-1', 'github.push', '{}',
           '2026-10-01T00:00:00Z', 'no_project_route')`,
      );
      const retentionB = new ReceiptRetention(machineB.runtime, machineB.locks);

      // Simulate Machine A holding the sweep advisory lock.
      await holder.query(`select pg_advisory_lock(hashtextextended('receipt-retention:sweep', 0))`);
      const skipped = await retentionB.runBatch(new Date("2026-10-27T00:00:00Z"));
      assert.deepEqual(skipped, { scanned: 0, deleted: 0, complete: false, skipped: true });

      const untouched = await machineB.runtime.query(
        `select id from provider_event_receipts where delivery_id = 'expired-1'`,
      );
      assert.equal(untouched.rowCount, 1);

      await holder.query(
        `select pg_advisory_unlock(hashtextextended('receipt-retention:sweep', 0))`,
      );
      const swept = await retentionB.runBatch(new Date("2026-10-27T00:00:00Z"));
      assert.deepEqual(swept, { scanned: 1, deleted: 1, complete: true, skipped: false });
    } finally {
      await holder.end().catch(() => undefined);
      await Promise.allSettled([machineA.runtime.close(), machineB.runtime.close()]);
    }
  }, 120_000);

  it("claims pendingGitHubInstallationSyncs exclusively across overlapping machines", async () => {
    const url = databaseUrl(postgres, "github_sync_skip_locked_test");
    const machineA = await postgresDatabaseRuntime(url);
    await machineA.runtime.migrate();
    const machineB = await postgresDatabaseRuntime(url);
    const dbA = createDatabase(machineA.runtime, machineA.locks);
    const dbB = createDatabase(machineB.runtime, machineB.locks);
    try {
      await machineA.runtime.query(
        `insert into organization (id, name, slug) values ('org-gh', 'GH Org', 'org-gh')`,
      );
      await machineA.runtime.query(
        `insert into github_connections
           (provider_application_id, organization_id, installation_id, slug, account_id, account_login, account_type, status)
         values ('42', 'org-gh', 42, 'acme', '1', 'acme', 'Organization', 'active')`,
      );
      await machineA.runtime.query(
        `insert into runtime_provider_activation
           (provider, provider_application_id, configuration_version)
         values ('github', '42', 0)`,
      );
      await dbA.claimGitHubLifecycleReceipt({
        providerApplicationId: "42",
        installationId: 42,
        deliveryId: "overlap-delivery",
        signatureHash: "overlap-sig",
        source: "github.installation",
        payload: {},
        receivedAt: new Date(),
      });

      const [claimsA, claimsB] = await Promise.all([
        dbA.pendingGitHubInstallationSyncs(GITHUB_OWNER),
        dbB.pendingGitHubInstallationSyncs(GITHUB_OWNER),
      ]);
      assert.equal(claimsA.length + claimsB.length, 1);

      // A second immediate poll while the first claim is still in flight must also see nothing.
      const secondPoll = await dbB.pendingGitHubInstallationSyncs(GITHUB_OWNER);
      assert.deepEqual(secondPoll, []);
    } finally {
      await Promise.allSettled([machineA.runtime.close(), machineB.runtime.close()]);
    }
  }, 120_000);
});
