import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createDatabase } from "./pg.js";
import {
  compileHubConfig,
  compiledConfigurationHash,
  type CompiledHubConfig,
} from "../config/compiler.js";
import type { AgentExecutionRecord, Database } from "./types.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { DurableTrigger } from "../db/types.js";
import { durableExecutionId } from "../daemons/lifecycle.js";
import type { RejectedTriggerProviderMatch, TriggerProviderMatch } from "../triggers/index.js";
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
      const created = await fixture.database.createAcceptedTriggerRun({
        organizationId: "org-1",
        projectId: fixture.execution.projectId,
        configurationRevisionId: fixture.execution.configurationRevisionId,
        triggerId: trigger.trigger.id,
        configuredTriggerName: "one-step",
        rawPrompt: "@Paseo repo=hub investigate",
        prompt: "investigate",
        inputs: { repo: "hub" },
        triggerContext: intent.triggerContext,
        outputContext: intent.outputContext,
        deadlineAt: new Date(Date.now() + 60_000),
        stepIds: ["step-one"],
      });
      assert.deepEqual((await fixture.database.findTriggerRunsByTriggerId(trigger.trigger.id))[0], {
        ...created.run,
        rawPrompt: "@Paseo repo=hub investigate",
        prompt: "investigate",
        inputs: { repo: "hub" },
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
      await fixture.database.succeedTriggerRun(created.run.id);
      assert.equal(
        (await fixture.database.findTriggerRunById(created.run.id))?.status,
        "succeeded",
      );
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

      await Promise.all([handler(durableTrigger), handler(durableTrigger)]);

      const run = (await fixture.database.findTriggerRunsByTriggerId(trigger.trigger.id))[0];
      assert.ok(run);
      if (run.outcome !== "accepted") throw new Error("expected accepted trigger run");
      const step = await fixture.database.findWorkflowStepRunByTriggerRun(run.id);
      assert.ok(step);
      assert.equal(run.deadlineAt.toISOString(), "2026-08-05T13:00:00.000Z");
      assert.equal((await fixture.database.claimWorkflowWakeup(now, 1_000)) !== undefined, true);
      assert.equal(
        await fixture.database.claimWorkflowWakeup(new Date(now.getTime() + 500), 1_000),
        undefined,
      );

      now = new Date("2026-08-05T12:00:04.500Z");
      await engine.processAvailable();
      const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
      assert.ok(execution);
      assert.equal(execution.deadlineAt?.toISOString(), "2026-08-05T12:00:34.500Z");
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
      assert.equal(first?.run.status, "running");
      assert.deepEqual(second, first);
      await fixture.database.succeedTriggerRun(run.id);
      assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "succeeded");
      assert.equal(await fixture.database.claimWorkflowWakeup(now, 1_000), undefined);
    } finally {
      await fixture.database.close();
    }
  });

  it("fans one PostgreSQL receipt into independently idempotent configured-trigger branches", async () => {
    const fixture = await executionFixture(postgres);
    let dispatches = 0;
    try {
      const matches = [
        phaseOneMatch(fixture.execution.configurationRevisionId, "first-route", "first-step"),
        phaseOneMatch(fixture.execution.configurationRevisionId, "second-route", "second-step"),
      ];
      const { handler, engine } = createDurableWorkflowHandler({
        database: fixture.database,
        providers: [
          {
            name: "test",
            eventNames: ["test.event"],
            async match() {
              return matches;
            },
          },
        ],
        dispatchLaunchMachineIntent: async (intent) => {
          dispatches += 1;
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
        "postgres-fanout",
      );
      const durableTrigger = toDurableTrigger(trigger.trigger);

      await Promise.all([handler(durableTrigger), handler(durableTrigger)]);
      const runs = await fixture.database.findTriggerRunsByTriggerId(trigger.trigger.id);
      assert.equal(runs.length, 2);
      assert.deepEqual(runs.map((run) => run.configuredTriggerName).sort(), [
        "first-route",
        "second-route",
      ]);
      const activity = (
        await fixture.database.listTriggersForProject(fixture.execution.projectId, 10)
      ).find((candidate) => candidate.id === trigger.trigger.id);
      assert.deepEqual(activity?.configuredTriggerNames.toSorted(), [
        "first-route",
        "second-route",
      ]);
      await Promise.all(
        runs.flatMap((run) => [
          fixture.database.wakeWorkflowRun(run.id, new Date()),
          fixture.database.wakeWorkflowRun(run.id, new Date()),
        ]),
      );

      await engine.processAvailable();
      const branches = await Promise.all(
        runs.map(async (run) => {
          const step = await fixture.database.findWorkflowStepRunByTriggerRun(run.id);
          assert.ok(step);
          const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
          assert.ok(execution);
          return { run, execution };
        }),
      );
      assert.equal(dispatches, 2);
      assert.equal(new Set(branches.map(({ execution }) => execution.id)).size, 2);

      const first = branches[0]!;
      const second = branches[1]!;
      await fixture.database.transitionAgentExecution(first.execution.id, "succeeded", {
        result: { route: first.run.configuredTriggerName },
      });
      const firstFinish = await fixture.database.completeWorkflowStep(
        first.execution.id,
        "succeeded",
        {
          route: first.run.configuredTriggerName,
        },
      );
      const firstDuplicateFinish = await fixture.database.completeWorkflowStep(
        first.execution.id,
        "succeeded",
        {
          route: first.run.configuredTriggerName,
        },
      );
      assert.deepEqual(firstDuplicateFinish, firstFinish);
      assert.equal((await fixture.database.findTriggerRunById(first.run.id))?.status, "running");
      assert.equal((await fixture.database.findTriggerRunById(second.run.id))?.status, "running");

      await fixture.database.transitionAgentExecution(second.execution.id, "succeeded", {
        result: { route: second.run.configuredTriggerName },
      });
      const secondFinish = await fixture.database.completeWorkflowStep(
        second.execution.id,
        "succeeded",
        {
          route: second.run.configuredTriggerName,
        },
      );
      assert.deepEqual(
        await fixture.database.completeWorkflowStep(second.execution.id, "succeeded", {
          route: second.run.configuredTriggerName,
        }),
        secondFinish,
      );
      await handler(durableTrigger);
      await engine.processAvailable();
      assert.equal((await fixture.database.findTriggerRunById(second.run.id))?.status, "succeeded");
      assert.equal(dispatches, 2);
      assert.equal(
        (await fixture.database.findTriggerRunsByTriggerId(trigger.trigger.id)).length,
        2,
      );
    } finally {
      await fixture.database.close();
    }
  });

  it("persists accepted and rejected PostgreSQL fan-out branches independently", async () => {
    const fixture = await executionFixture(postgres);
    let dispatches = 0;
    try {
      const accepted = phaseOneMatch(
        fixture.execution.configurationRevisionId,
        "accepted-route",
        "accepted-step",
      );
      const rejected: RejectedTriggerProviderMatch = {
        triggerName: "rejected-route",
        triggerContext: { provider: "slack" },
        outputContext: {},
        configurationRevisionId: fixture.execution.configurationRevisionId,
        hubConfig: {},
        invocation: {
          status: "rejected" as const,
          rawMessage: "repo=unknown investigate",
          prompt: "investigate",
          inputs: {},
          reason: "input repo must be one of the declared choices",
          rejection: {
            code: "invalid_choice",
            inputName: "repo",
            value: "unknown",
            choices: ["hub"],
          },
        },
      };
      const secondRejected: RejectedTriggerProviderMatch = {
        ...rejected,
        triggerName: "second-rejected-route",
        invocation: {
          ...rejected.invocation,
          reason: "duplicate input repo",
          rejection: { code: "duplicate_input" as const, inputName: "repo" },
        },
      };
      const { handler, engine } = createDurableWorkflowHandler({
        database: fixture.database,
        providers: [
          {
            name: "test",
            eventNames: ["test.event"],
            async match() {
              return [accepted, rejected, secondRejected];
            },
          },
        ],
        dispatchLaunchMachineIntent: async (intent) => {
          dispatches += 1;
          return {
            execution: await fixture.database.insertAgentExecution({
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
            }),
          };
        },
      });
      const trigger = await insertWorkflowTrigger(
        fixture.database,
        fixture.execution.configurationRevisionId,
        "postgres-mixed-fanout",
      );
      const durableTrigger = toDurableTrigger(trigger.trigger);

      await Promise.all([handler(durableTrigger), handler(durableTrigger)]);
      await engine.processAvailable();

      const runs = await fixture.database.findTriggerRunsByTriggerId(trigger.trigger.id);
      assert.equal(runs.length, 3);
      assert.deepEqual(
        runs
          .map((run) => ({ name: run.configuredTriggerName, status: run.status }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        [
          { name: "accepted-route", status: "running" },
          { name: "rejected-route", status: "rejected" },
          { name: "second-rejected-route", status: "rejected" },
        ],
      );
      const rejectedRun = runs.find((run) => run.configuredTriggerName === "rejected-route");
      assert.ok(rejectedRun);
      if (rejectedRun.outcome !== "rejected") throw new Error("expected rejected branch");
      assert.equal(rejectedRun.rejection.code, "invalid_choice");
      assert.equal(
        await fixture.database.findWorkflowStepRunByTriggerRun(rejectedRun.id),
        undefined,
      );
      const secondRejectedRun = runs.find(
        (run) => run.configuredTriggerName === "second-rejected-route",
      );
      assert.ok(secondRejectedRun);
      if (secondRejectedRun.outcome !== "rejected") throw new Error("expected rejected branch");
      assert.equal(secondRejectedRun.rejection.code, "duplicate_input");
      assert.equal(
        await fixture.database.findWorkflowStepRunByTriggerRun(secondRejectedRun.id),
        undefined,
      );
      assert.equal(dispatches, 1);
      assert.equal(
        (await fixture.database.findTriggerById(trigger.trigger.id))?.droppedReason,
        null,
      );
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

function phaseOneMatch(
  configurationRevisionId: string,
  triggerName = "one-step",
  stepId = "step-one",
): TriggerProviderMatch {
  const base = launchIntent("trigger-placeholder", configurationRevisionId, triggerName);
  return {
    triggerName,
    triggerContext: base.triggerContext,
    outputContext: base.outputContext,
    configurationRevisionId,
    hubConfig: workflowConfiguration(triggerName, stepId),
    invocation: {
      status: "accepted",
      rawMessage: "run",
      prompt: "run",
      inputs: {},
    },
  };
}

function workflowConfiguration(triggerName: string, stepId: string): CompiledHubConfig {
  return activateWorkflowConfiguration(
    compileHubConfig({
      environments: [{ name: "work", kind: "daemon", daemon: "daemon", cwd: "/repo" }],
      triggers: [
        {
          name: triggerName,
          on: "test.event",
          max_runtime: "1h",
          filters: { from_users: ["test"] },
          steps: [
            {
              id: stepId,
              environment: "work",
              max_runtime: "30s",
              idle_timeout: "5s",
              agent: { provider: "test" },
              prompt: [{ text: "run" }],
            },
          ],
        },
      ],
    }),
  );
}

function allWorkflowConfigurations(): CompiledHubConfig {
  const definitions = [
    ["one-step", "step-one"],
    ["first-route", "first-step"],
    ["second-route", "second-step"],
    ["accepted-route", "accepted-step"],
    ["rejected-route", "rejected-step"],
    ["second-rejected-route", "second-rejected-step"],
  ] as const;
  const configurations = definitions.map(([triggerName, stepId]) =>
    workflowConfiguration(triggerName, stepId),
  );
  return {
    environments: configurations[0]!.environments,
    triggers: configurations.flatMap((configuration) => configuration.triggers),
  };
}

function activateWorkflowConfiguration(configuration: CompiledHubConfig): CompiledHubConfig {
  return {
    environments: configuration.environments.map((environment) => {
      if (environment.kind !== "daemon") return environment;
      return {
        name: environment.name,
        kind: "daemon",
        daemon: environment.daemon,
        daemonId: "daemon-1",
        cwd: environment.cwd,
        ...(environment.worktree === undefined ? {} : { worktree: environment.worktree }),
      };
    }),
    triggers: configuration.triggers,
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

  const revisionConfiguration = allWorkflowConfigurations();
  const config = await database.insertProjectConfigurationRevision({
    projectId: "00000000-0000-4000-8000-000000000001",
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: revisionConfiguration,
    contentHash: compiledConfigurationHash(revisionConfiguration),
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
