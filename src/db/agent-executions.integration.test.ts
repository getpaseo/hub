import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createDatabase } from "./pg.js";
import type { AgentExecutionRecord, Database } from "./types.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { DurableTrigger } from "../db/types.js";
import { durableExecutionId } from "../daemons/lifecycle.js";
import type { TriggerProviderMatch } from "../triggers/index.js";
import { createDurableWorkflowHandler } from "../workflows/engine.js";

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

  it("persists one run, one step, explicit execution ownership, and idempotent finish", async () => {
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
      const intent = launchIntent(
        trigger.trigger.id,
        fixture.execution.configurationRevisionId,
        "one-step",
      );
      const created = await fixture.database.createTriggerRun({
        organizationId: "org-1",
        projectId: fixture.execution.projectId,
        configurationRevisionId: fixture.execution.configurationRevisionId,
        triggerId: trigger.trigger.id,
        rawPrompt: "raw",
        prompt: intent.prompt,
        deadlineAt: new Date(Date.now() + 60_000),
        stepId: "step-one",
        dispatchIntent: intent,
      });
      const step = await fixture.database.findWorkflowStepRunByTriggerRun(created.run.id);
      assert.ok(step);
      const execution = await fixture.database.insertAgentExecution({
        organizationId: "org-1",
        projectId: fixture.execution.projectId,
        machineId: fixture.execution.machineId,
        triggerId: trigger.trigger.id,
        triggerContext: intent.triggerContext,
        outputContext: intent.outputContext,
        configurationRevisionId: fixture.execution.configurationRevisionId,
        workflowStepRunId: step.id,
        launchIntent: intent,
      });
      await fixture.database.linkWorkflowStepRunExecution(step.id, execution.id);
      assert.equal(
        (await fixture.database.findWorkflowStepRunById(step.id))?.agentExecutionId,
        execution.id,
      );
      await fixture.database.transitionAgentExecution(execution.id, "succeeded", {
        result: { status: "succeeded" },
      });
      const first = await fixture.database.completeWorkflowStep(execution.id, "succeeded", {
        status: "succeeded",
      });
      const second = await fixture.database.completeWorkflowStep(execution.id, "succeeded", {
        status: "succeeded",
      });
      assert.equal(first?.run.status, "succeeded");
      assert.deepEqual(second, first);
    } finally {
      await fixture.database.close();
    }
  });

  it("keeps delivery, wakeup lease, deadline, and finish idempotent in PostgreSQL", async () => {
    const fixture = await executionFixture(postgres);
    let now = new Date("2026-08-05T12:00:00.000Z");
    try {
      const providerMatch = phaseOneMatch(fixture.execution.configurationRevisionId);
      const { handler, engine } = createDurableWorkflowHandler({
        database: fixture.database,
        providers: [
          {
            name: "test",
            eventNames: ["test.event"],
            async match() {
              return [providerMatch];
            },
          },
        ],
        now: () => now,
        leaseMs: 1_000,
        dispatchLaunchMachineIntent: async (intent) => {
          const execution = await fixture.database.insertAgentExecution({
            id: durableExecutionId(intent),
            organizationId: intent.organizationId,
            projectId: intent.projectId,
            machineId: fixture.execution.machineId,
            triggerId: intent.triggerId,
            triggerContext: intent.triggerContext,
            outputContext: intent.outputContext,
            configurationRevisionId: intent.configurationRevisionId,
            workflowStepRunId: intent.workflowStepRunId!,
            deadlineAt: intent.deadlineAt ?? null,
            launchIntent: intent,
          });
          return { execution };
        },
      });
      const trigger = await insertWorkflowTrigger(
        fixture.database,
        fixture.execution.configurationRevisionId,
        "postgres-delivery",
      );
      const durableTrigger = toDurableTrigger(trigger.trigger);

      await handler(durableTrigger);
      await handler(durableTrigger);

      const run = await fixture.database.findTriggerRunByTriggerId(trigger.trigger.id);
      assert.ok(run);
      const step = await fixture.database.findWorkflowStepRunByTriggerRun(run.id);
      assert.ok(step);
      assert.equal(run.deadlineAt.toISOString(), "2026-08-05T12:00:05.000Z");
      assert.equal((await fixture.database.claimWorkflowWakeup(now, 1_000)) !== undefined, true);
      assert.equal(
        await fixture.database.claimWorkflowWakeup(new Date(now.getTime() + 500), 1_000),
        undefined,
      );

      now = new Date("2026-08-05T12:00:04.500Z");
      await engine.processAvailable();
      const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
      assert.ok(execution);
      assert.equal(execution.deadlineAt?.toISOString(), "2026-08-05T12:00:05.000Z");
      assert.equal(execution.workflowStepRunId, step.id);

      await fixture.database.transitionAgentExecution(execution.id, "succeeded", {
        result: { status: "succeeded" },
      });
      const first = await fixture.database.completeWorkflowStep(execution.id, "succeeded", {
        status: "succeeded",
      });
      const second = await fixture.database.completeWorkflowStep(execution.id, "succeeded", {
        status: "succeeded",
      });
      assert.equal(first?.run.status, "succeeded");
      assert.deepEqual(second, first);
      assert.equal(await fixture.database.claimWorkflowWakeup(now, 1_000), undefined);
    } finally {
      await fixture.database.close();
    }
  });

  it("atomically enforces the configured reply limit under concurrent callers", async () => {
    const fixture = await executionFixture(postgres);
    try {
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          fixture.database.claimAgentExecutionReply(
            fixture.execution.id,
            3,
            new Date(`2026-08-03T00:00:0${index}.000Z`),
          ),
        ),
      );

      assert.equal(claims.filter(Boolean).length, 3);
      assert.equal(
        (await fixture.database.findAgentExecutionById(fixture.execution.id))?.replyClaimedAt !==
          null,
        true,
      );
      assert.equal(
        (await fixture.database.findAgentExecutionById(fixture.execution.id))?.replyClaimCount,
        3,
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

function phaseOneMatch(configurationRevisionId: string): TriggerProviderMatch {
  const base = launchIntent("trigger-placeholder", configurationRevisionId, "one-step");
  return {
    triggerName: "one-step",
    stepId: "step-one",
    environmentName: base.environmentName,
    environment: base.environment,
    prompt: base.prompt,
    agent: base.agent,
    allowOutputs: base.allowOutputs,
    timeoutMs: 30_000,
    runTimeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    autoArchive: base.autoArchive,
    triggerContext: base.triggerContext,
    outputContext: base.outputContext,
    configurationRevisionId,
    hubConfig: base.hubConfig,
  };
}

async function insertWorkflowTrigger(
  database: Database,
  configurationRevisionId: string,
  deliveryId: string,
) {
  return database.insertTrigger({
    organizationId: "org-1",
    projectId: "00000000-0000-4000-8000-000000000001",
    configurationRevisionId,
    deliveryId,
    source: "test.event",
    payload: { prompt: "raw" },
    receivedAt: new Date("2026-08-05T12:00:00.000Z"),
  });
}

function toDurableTrigger(
  trigger: Awaited<ReturnType<Database["insertTrigger"]>>["trigger"],
): DurableTrigger {
  if (trigger.projectId === null) throw new Error("workflow trigger project is required");
  return {
    triggerId: trigger.id,
    organizationId: trigger.organizationId,
    projectId: trigger.projectId,
    source: trigger.source,
    deliveryId: trigger.deliveryId,
    payload: trigger.payload,
    receivedAt: trigger.receivedAt,
    connectionId: trigger.connectionId,
    resourceId: trigger.resourceId,
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
