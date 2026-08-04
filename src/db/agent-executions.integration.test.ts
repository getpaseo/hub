import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createDatabase } from "./pg.js";
import type { AgentExecutionRecord, Database } from "./types.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";

describe("agent execution PostgreSQL repository", () => {
  let postgres: StartedPostgreSqlContainer;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  }, 120_000);

  it("commits one complete terminal outcome under concurrent finality", async () => {
    const fixture = await executionFixture(postgres);
    const terminals = [
      {
        status: "succeeded" as const,
        result: { status: "succeeded" },
        hubAction: "archive" as const,
      },
      {
        status: "failed" as const,
        result: { status: "failed", reason: "timeout" },
        hubAction: "interrupt" as const,
      },
    ];

    try {
      const attempts = await Promise.all(
        terminals.map(async (terminal) => ({
          terminal,
          transition: await fixture.database.transitionAgentExecution(
            fixture.execution.id,
            terminal.status,
            { result: terminal.result, hubAction: terminal.hubAction },
          ),
        })),
      );

      assert.equal(attempts.filter(({ transition }) => transition.transitioned).length, 1);
      const winner = attempts.find(({ transition }) => transition.transitioned);
      assert.ok(winner);
      const persisted = await fixture.database.findAgentExecutionById(fixture.execution.id);
      assert.ok(persisted);
      assert.deepEqual(
        { status: persisted.status, result: persisted.result, hubAction: persisted.hubAction },
        winner.terminal,
      );
    } finally {
      await fixture.database.close();
    }
  });

  it("claims one immutable dispatch plan and advances lifecycle monotonically", async () => {
    const fixture = await executionFixture(postgres);
    try {
      const trigger = await fixture.database.insertTrigger({
        organizationId: "org-1",
        projectId: fixture.execution.projectId,
        configurationRevisionId: fixture.execution.configurationRevisionId,
        deliveryId: randomUUID(),
        source: "slack.mention",
        payload: {},
        receivedAt: new Date(),
      });
      const plans = ["first", "second"].map((triggerName) => [
        launchIntent(trigger.trigger.id, fixture.execution.configurationRevisionId, triggerName),
      ]);

      const claims = await Promise.all(
        plans.map((plan) => fixture.database.claimTriggerDispatchPlan(trigger.trigger.id, plan)),
      );
      assert.equal(claims.filter((claim) => claim.claimed).length, 1);
      assert.deepEqual(claims[0]?.plan, claims[1]?.plan);

      assert.equal(
        (await fixture.database.transitionTriggerLifecycle(trigger.trigger.id, "accepted"))
          .transitioned,
        true,
      );
      assert.equal(
        (await fixture.database.transitionTriggerLifecycle(trigger.trigger.id, "running"))
          .transitioned,
        true,
      );
      assert.equal(
        (await fixture.database.transitionTriggerLifecycle(trigger.trigger.id, "accepted"))
          .transitioned,
        false,
      );
    } finally {
      await fixture.database.close();
    }
  });

  it("atomically burns one reply claim under concurrent callers", async () => {
    const fixture = await executionFixture(postgres);
    try {
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          fixture.database.claimAgentExecutionReply(
            fixture.execution.id,
            new Date(`2026-08-03T00:00:0${index}.000Z`),
          ),
        ),
      );

      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(
        (await fixture.database.findAgentExecutionById(fixture.execution.id))?.replyClaimedAt !==
          null,
        true,
      );
    } finally {
      await fixture.database.close();
    }
  });
});

function launchIntent(
  triggerId: string,
  configurationRevisionId: string,
  triggerName: string,
): LaunchMachineIntent {
  return {
    kind: "launch_machine",
    organizationId: "org-1",
    projectId: "00000000-0000-4000-8000-000000000001",
    triggerId,
    triggerName,
    environmentName: "work",
    environment: {
      kind: "daemon",
      daemonId: "daemon-1",
      authoredSlug: "daemon",
      cwd: "/repo",
    },
    prompt: "run",
    agent: { provider: "test", mode: "full-access" },
    allowOutputs: [],
    autoArchive: false,
    triggerContext: { provider: "slack" },
    outputContext: {},
    configurationRevisionId,
    hubConfig: {},
  };
}

async function executionFixture(
  postgres: StartedPostgreSqlContainer,
): Promise<{ database: Database; execution: AgentExecutionRecord }> {
  const url = new URL(postgres.getConnectionUri());
  url.pathname = `/execution_finality_${randomUUID().replaceAll("-", "")}`;
  const database = await createDatabase(url.toString());
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(
    "insert into organization (id, name, slug) values ('org-1', 'Finality', 'finality')",
  );
  await client.query(
    `insert into projects (id, organization_id, name, slug)
     values ('00000000-0000-4000-8000-000000000001', 'org-1', 'Default', 'default')`,
  );
  await client.end();

  const config = await database.insertProjectConfigurationRevision({
    projectId: "00000000-0000-4000-8000-000000000001",
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: {},
    contentHash: "test-config",
  });
  const machine = await database.insertMachine({
    orgId: "org-1",
    source: { kind: "daemon", daemonId: "daemon-1" },
    status: "alive",
  });
  const execution = await database.insertAgentExecution({
    organizationId: "org-1",
    projectId: "00000000-0000-4000-8000-000000000001",
    machineId: machine.id,
    triggerContext: null,
    outputContext: null,
    configurationRevisionId: config.id,
  });
  await database.transitionAgentExecution(execution.id, "running");
  return { database, execution };
}
