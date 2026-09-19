import { createHubRuntime, createHubApplication } from "../../app.js";
import { ScheduleTestDaemon } from "./test-daemon.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  type DatabaseRuntimeBundle,
} from "../../db/runtime/index.js";
import { createDatabase } from "../../db/pg.js";
import { OrganizationTriggerStore } from "../store.js";
import { DurableWorkflowEngine } from "../../workflows/engine.js";
import { createUnlimitedEntitlementsService } from "../../entitlements/test-utils.js";
import { scheduleYaml } from "./test-fixture.js";
import { createScheduleProvider } from "./index.js";

let postgres: StartedPostgreSqlContainer;
beforeAll(async () => {
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
}, 120_000);
afterAll(async () => {
  await postgres?.stop();
});

describe.each(["embedded", "postgres"] as const)("schedule on %s", (kind) => {
  it("atomically coalesces downtime, skips overlap, preserves execution edits, and honors disable/re-enable", async () => {
    const fixture = await setup(kind);
    try {
      const { database, store } = fixture;
      let trigger = await store.save({ yaml: scheduleYaml, userId: null });
      const firstDue = await fixture.due();
      expect(await database.schedules.tick(new Date(firstDue.getTime() - 1))).toBe(0);
      const catchUpAt = new Date(firstDue.getTime() + 3 * 86400_000);
      expect(await database.schedules.tick(catchUpAt)).toBe(1);
      const [receipt] = await fixture.receipts();
      expect(receipt!.delivery_id).toBe(`schedule:${trigger.id}:${firstDue.toISOString()}`);
      const [run] = await database.findTriggerRunsByProviderEventReceiptId(receipt!.id);
      expect(run).toMatchObject({ outcome: "accepted", status: "running" });
      expect(await database.listWorkflowStepRunsForTriggerRun(run!.id)).toHaveLength(1);
      expect(await fixture.count("workflow_wakeups")).toBe(1);
      expect(await database.schedules.tick(await fixture.due())).toBe(0);
      const beforeEdit = await fixture.due();
      trigger = await store.save({
        triggerId: trigger.id,
        yaml: scheduleYaml.replace("Scan at", "Inspect at"),
        userId: null,
      });
      expect(await fixture.due()).toEqual(beforeEdit);
      await store.save({
        triggerId: trigger.id,
        yaml: `enabled: false\n${scheduleYaml}`,
        userId: null,
      });
      expect(await database.schedules.tick(new Date("2099-01-01"))).toBe(0);
      await store.save({ triggerId: trigger.id, yaml: scheduleYaml, userId: null });
      expect(await database.schedules.tick(await fixture.due())).toBe(0);
      await database.failWorkflowRun(run!.id, "failed", "test_finished");
      expect(await database.schedules.tick(await fixture.due())).toBe(1);
      expect(await fixture.receipts()).toHaveLength(2);
      await store.save({
        triggerId: trigger.id,
        yaml: scheduleYaml.replace("BYHOUR=9,17", "BYHOUR=23;BYMINUTE=15"),
        userId: null,
      });
      expect((await fixture.due()).getTime()).toBeGreaterThan(Date.now() - 1000);
    } finally {
      await fixture.close();
    }
  });

  it("persists finite exhaustion and retains one catch-up after the final occurrence", async () => {
    const fixture = await setup(kind);
    try {
      const start = new Date(Date.now() + 86400_000).toISOString().slice(0, 19);
      const yaml = scheduleYaml
        .replace("2026-01-01T09:00:00", start)
        .replace("FREQ=DAILY;BYHOUR=9,17", "FREQ=MINUTELY;COUNT=1")
        .replace("Europe/Berlin", "UTC");
      const trigger = await fixture.store.save({ yaml, userId: null });
      const due = await fixture.due();
      expect(await fixture.database.schedules.tick(new Date(due.getTime() + 86400_000))).toBe(1);
      const state = await fixture.bundle.runtime.query<{ next_at: Date | null }>(
        "select next_at from trigger_schedules where trigger_id = $1",
        [trigger.id],
      );
      expect(state.rows[0]!.next_at).toBeNull();
      await fixture.reopen();
      expect(await fixture.database.schedules.tick(new Date("2099-01-01"))).toBe(0);
      expect(await fixture.receipts()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("rolls back occurrence identity and advancement together, and recovers after reopening storage", async () => {
    const fixture = await setup(kind);
    try {
      await fixture.store.save({ yaml: scheduleYaml, userId: null });
      const due = await fixture.due();
      // A real constraint failure after receipt insertion proves the entire intake is atomic.
      await fixture.bundle.runtime.query(
        "alter table workflow_wakeups add constraint reject_test_wakeup check (false) not valid",
      );
      await expect(fixture.database.schedules.tick(due)).rejects.toThrow();
      expect(await fixture.receipts()).toHaveLength(0);
      expect(await fixture.count("trigger_runs")).toBe(0);
      expect(await fixture.due()).toEqual(due);
      await fixture.bundle.runtime.query(
        "alter table workflow_wakeups drop constraint reject_test_wakeup",
      );
      await fixture.reopen();
      expect(await fixture.database.schedules.tick(due)).toBe(1);
      await fixture.reopen();
      expect(await fixture.database.schedules.tick(due)).toBe(0);
      expect(await fixture.receipts()).toHaveLength(1);
      expect(await fixture.count("workflow_wakeups")).toBe(1);
    } finally {
      await fixture.close();
    }
  });
});

it("two independent Hub workers leave queued work for the process with the daemon connection", async () => {
  const fixture = await setup("postgres");
  const peer = await postgresDatabaseRuntime(fixture.connectionString!);
  const peerDatabase = createDatabase(peer.runtime, peer.locks);
  const dispatches: { worker: string; prompt: string }[] = [];
  let connected = false;
  let time = new Date();
  const worker = (database: typeof peerDatabase, name: string, ownsConnection: () => boolean) =>
    new DurableWorkflowEngine({
      database,
      entitlements: createUnlimitedEntitlementsService(),
      providers: [createScheduleProvider()],
      now: () => time,
      canDispatchToDaemon: (id) => id === fixture.daemonId && ownsConnection(),
      dispatchLaunchMachineIntent: async (intent) => {
        dispatches.push({ worker: name, prompt: intent.prompt });
        const execution = await database.findAgentExecutionByWorkflowStepRunId(
          intent.workflowStepRunId!,
        );
        expect(execution).toBeDefined();
        await database.transitionAgentExecution(execution!.id, "running");
        return { execution: await database.findAgentExecutionById(execution!.id) };
      },
    });
  const first = worker(fixture.database, "without-connection", () => false);
  const second = worker(peerDatabase, "connection-owner", () => connected);
  try {
    await fixture.store.save({ yaml: scheduleYaml, userId: null });
    time = await fixture.due();
    const results = await Promise.all([
      fixture.database.schedules.tick(time),
      peerDatabase.schedules.tick(time),
    ]);
    expect(results.sort((left, right) => left - right)).toEqual([0, 1]);
    await first.processAvailable();
    await second.processAvailable();
    expect(dispatches).toEqual([]);
    expect(await fixture.count("agent_executions")).toBe(0);
    connected = true;
    await first.processAvailable();
    await second.processAvailable();
    await Promise.all([first.processAvailable(), second.processAvailable()]);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.worker).toBe("connection-owner");
    expect(dispatches[0]!.prompt).toContain(time.toISOString());
    expect(await fixture.count("agent_executions")).toBe(1);
    expect(await fixture.count("workflow_wakeups")).toBe(0);
  } finally {
    await first.stop();
    await second.stop();
    await peer.runtime.close();
    await fixture.close();
  }
});

it("Hub runtime dispatches through the peer daemon port and completes ordinary scheduled history", async () => {
  const fixture = await setup("postgres");
  const peer = await postgresDatabaseRuntime(fixture.connectionString!);
  const peerDatabase = createDatabase(peer.runtime, peer.locks);
  const connection = new ScheduleTestDaemon();
  let time = new Date();
  let connected = false;
  const options = {
    entitlements: createUnlimitedEntitlementsService(),
    publicApi: { status: "unavailable" as const },
    publicBaseUrl: "http://schedule.test",
    completionTokenSecret: "schedule-test-secret",
    executionDeadlineClock: { now: () => time.getTime(), schedule: () => () => {} },
  };
  const first = createHubRuntime({ ...options, database: fixture.database });
  const second = createHubRuntime({
    ...options,
    database: peerDatabase,
    daemonConnectionForId: (id) => (connected && id === fixture.daemonId ? connection : undefined),
  });
  try {
    await fixture.store.save({ yaml: scheduleYaml, userId: null });
    time = await fixture.due();
    await fixture.database.schedules.tick(time);
    await first.processWorkflowOutbox();
    await second.processWorkflowOutbox();
    expect(connection.launches).toHaveLength(0);
    connected = true;
    await first.processWorkflowOutbox();
    await second.processWorkflowOutbox();
    await expect.poll(() => connection.prompts.length).toBe(1);
    await Promise.all([first.processWorkflowOutbox(), second.processWorkflowOutbox()]);
    expect(connection.launches).toHaveLength(1);
    expect(connection.launches[0]).toMatchObject({
      provider: "test",
      mode: "full-access",
      thinkingOptionId: "low",
      cwd: "/workspace",
    });
    expect(connection.prompts[0]).toContain(time.toISOString());
    const rows = await fixture.bundle.runtime.query<{ id: string; daemon_id: string }>(
      "select id, daemon_id from agent_executions",
    );
    expect(rows.rows[0]!.daemon_id).toBe(fixture.daemonId);
    const executionId = rows.rows[0]!.id;
    await fixture.database.transitionAgentExecution(executionId, "succeeded", {
      result: { summary: "Scan complete" },
    });
    await second.processWorkflowOutbox();
    const receipt = (await fixture.receipts())[0]!;
    expect(
      (await fixture.database.findTriggerRunsByProviderEventReceiptId(receipt.id))[0]?.status,
    ).toBe("succeeded");
    expect(await fixture.database.schedules.tick(await fixture.due())).toBe(1);
  } finally {
    await first.stop();
    await second.stop();
    await peer.runtime.close();
    await fixture.close();
  }
});

it("an expired worker cannot release a newer worker’s wakeup lease", async () => {
  const fixture = await setup("postgres");
  try {
    await fixture.store.save({ yaml: scheduleYaml, userId: null });
    const due = await fixture.due();
    await fixture.database.schedules.tick(due);
    const first = await fixture.database.claimWorkflowWakeup(due, 1000);
    const later = new Date(due.getTime() + 1001);
    const second = await fixture.database.claimWorkflowWakeup(later, 1000);
    expect(first?.triggerRunId).toBe(second?.triggerRunId);
    await fixture.database.releaseWorkflowWakeup(
      first!.triggerRunId,
      later,
      first!.leaseExpiresAt!,
    );
    expect(await fixture.database.claimWorkflowWakeup(later, 1000)).toBeUndefined();
    await fixture.database.releaseWorkflowWakeup(
      second!.triggerRunId,
      later,
      second!.leaseExpiresAt!,
    );
    expect(await fixture.database.claimWorkflowWakeup(later, 1000)).toMatchObject({
      triggerRunId: first!.triggerRunId,
      leasedBeforeClaim: true,
    });
  } finally {
    await fixture.close();
  }
});

it("validates, installs, exports and edits scheduled YAML through the existing public API", async () => {
  const fixture = await setup("embedded");
  const application = createHubApplication({
    database: fixture.database,
    entitlements: createUnlimitedEntitlementsService(),
    publicApi: {
      status: "enabled",
      authenticator: {
        async authorize() {
          return {
            status: "authorized",
            access: {
              kind: "apiKey",
              credentialId: randomUUID(),
              organizationId: "schedule-org",
              scopes: ["configuration:validate", "configuration:install"],
            },
          };
        },
      },
    },
  });
  const request = (action: string, yaml: string) =>
    application.publicApi.handle(
      new Request(`http://schedule.test/api/v1/triggers/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ yaml }),
      }),
    );
  try {
    expect((await request("validate", scheduleYaml)).status).toBe(200);
    expect((await request("install", scheduleYaml)).status).toBe(201);
    const edited = scheduleYaml.replace("BYHOUR=9,17", "BYHOUR=8,18;BYMINUTE=15,30;BYSETPOS=1,4");
    expect((await request("install", edited)).status).toBe(201);
    const response = await application.publicApi.handle(
      new Request("http://schedule.test/api/v1/triggers"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      triggers: [{ name: "scheduled-scan", yaml: edited }],
    });
    expect(await fixture.store.list()).toHaveLength(1);
    expect(await fixture.database.schedules.tick(await fixture.due())).toBe(1);
  } finally {
    await application.hub.stop();
    await fixture.close();
  }
});

async function setup(kind: "embedded" | "postgres") {
  const root = await mkdtemp(join(tmpdir(), "hub-schedule-"));
  const connectionString = kind === "postgres" ? new URL(postgres.getConnectionUri()) : undefined;
  if (connectionString !== undefined)
    connectionString.pathname = `/schedule_${randomUUID().replaceAll("-", "")}`;
  const open = (): Promise<DatabaseRuntimeBundle> =>
    connectionString === undefined
      ? embeddedDatabaseRuntime(join(root, "database"))
      : postgresDatabaseRuntime(connectionString.href);
  let bundle = await open();
  await bundle.runtime.migrate();
  let database = createDatabase(bundle.runtime, bundle.locks);
  await bundle.runtime.query(
    "insert into organization (id, name, slug) values ('schedule-org', 'Schedule test', 'schedule-test')",
  );
  await database.issueEnrollmentToken({
    id: randomUUID(),
    verifier: "schedule-test-token",
    organizationId: "schedule-org",
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
  });
  const daemonId = randomUUID();
  await database.enrollDaemon({
    daemonId,
    idempotencyKey: randomUUID(),
    suggestedSlug: "devbox",
    tokenVerifier: "schedule-test-token",
    serverId: randomUUID(),
    daemonPublicKey: "public",
    credentialVerifier: "credential",
    permissions: ["hub.execute"],
    now: new Date(),
  });
  return {
    get bundle() {
      return bundle;
    },
    get database() {
      return database;
    },
    get store() {
      return new OrganizationTriggerStore(database, "schedule-org");
    },
    daemonId,
    connectionString: connectionString?.href,
    async due() {
      const rows = await bundle.runtime.query<{ next_at: Date }>(
        "select next_at from trigger_schedules",
      );
      return rows.rows[0]!.next_at;
    },
    async receipts() {
      return (
        await bundle.runtime.query<{ id: string; delivery_id: string }>(
          "select id, delivery_id from provider_event_receipts order by received_at",
        )
      ).rows;
    },
    async count(table: "workflow_wakeups" | "trigger_runs" | "agent_executions") {
      return (
        await bundle.runtime.query<{ count: number }>(
          `select count(*)::integer as count from ${table}`,
        )
      ).rows[0]!.count;
    },
    async reopen() {
      await bundle.runtime.close();
      bundle = await open();
      database = createDatabase(bundle.runtime, bundle.locks);
    },
    async close() {
      await bundle.runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
