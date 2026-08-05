import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { durableExecutionId } from "../daemons/lifecycle.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { DurableTrigger } from "../db/types.js";
import { createDurableWorkflowHandler } from "./engine.js";

describe("durable Phase 1 workflow engine", () => {
  it("persists one run, one step, and one explicitly owned execution", async () => {
    const database = createMemoryDatabase();
    const trigger = await insertTrigger(database, "delivery-one");
    const { handler, engine } = createDurableWorkflowHandler({
      database,
      providers: [provider()],
      dispatchLaunchMachineIntent: async (intent) => {
        const execution = await database.insertAgentExecution({
          id: durableExecutionId(intent),
          organizationId: intent.organizationId,
          projectId: intent.projectId,
          machineId: null,
          triggerId: intent.triggerId,
          triggerContext: intent.triggerContext,
          outputContext: intent.outputContext,
          configurationRevisionId: intent.configurationRevisionId,
          workflowStepRunId: intent.workflowStepRunId!,
          launchIntent: intent,
        });
        return { execution };
      },
    });

    await handler(trigger);
    await engine.processAvailable();
    const run = (await database.findTriggerRunsByTriggerId(trigger.triggerId))[0];
    assert.ok(run);
    const step = await database.findWorkflowStepRunByTriggerRun(run.id);
    assert.ok(step);
    const execution = await database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);
    assert.equal(step.agentExecutionId, execution.id);
    assert.equal(execution.workflowStepRunId, step.id);
    assert.equal(step.status, "running");
  });

  it("fans one provider receipt out to one durable branch per configured trigger", async () => {
    const database = createMemoryDatabase();
    const trigger = await insertTrigger(database, "delivery-fanout");
    const matches = [
      providerMatch("first-trigger", "first-step").match,
      providerMatch("second-trigger", "second-step").match,
    ];
    let dispatches = 0;
    const { handler, engine } = createDurableWorkflowHandler({
      database,
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
        return {
          execution: await database.insertAgentExecution({
            id: durableExecutionId(intent),
            organizationId: intent.organizationId,
            projectId: intent.projectId,
            machineId: null,
            triggerId: intent.triggerId,
            triggerContext: intent.triggerContext,
            outputContext: intent.outputContext,
            configurationRevisionId: intent.configurationRevisionId,
            workflowStepRunId: intent.workflowStepRunId!,
            launchIntent: intent,
          }),
        };
      },
    });

    await handler(trigger);
    await handler(trigger);
    await engine.processAvailable();

    const runs = await database.findTriggerRunsByTriggerId(trigger.triggerId);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((run) => run.configuredTriggerName).sort(), [
      "first-trigger",
      "second-trigger",
    ]);
    assert.deepEqual(
      (await database.findTriggerById(trigger.triggerId))?.configuredTriggerNames.toSorted(),
      ["first-trigger", "second-trigger"],
    );
    await Promise.all(
      runs.flatMap((run) => [
        database.wakeWorkflowRun(run.id, new Date()),
        database.wakeWorkflowRun(run.id, new Date()),
      ]),
    );
    const branches = await Promise.all(
      runs.map(async (run) => {
        const step = await database.findWorkflowStepRunByTriggerRun(run.id);
        assert.ok(step);
        const execution = await database.findAgentExecutionByWorkflowStepRunId(step.id);
        assert.ok(execution);
        return { run, step, execution };
      }),
    );
    assert.equal(dispatches, 2);
    assert.equal(new Set(branches.map(({ execution }) => execution.id)).size, 2);

    const first = branches[0]!;
    const second = branches[1]!;
    await database.transitionAgentExecution(first.execution.id, "succeeded", {
      result: { branch: first.run.configuredTriggerName },
    });
    const firstFinish = await database.completeWorkflowStep(first.execution.id, "succeeded", {
      branch: first.run.configuredTriggerName,
    });
    assert.deepEqual(
      await database.completeWorkflowStep(first.execution.id, "succeeded", {
        branch: first.run.configuredTriggerName,
      }),
      firstFinish,
    );
    assert.equal((await database.findTriggerRunById(first.run.id))?.status, "succeeded");
    assert.equal((await database.findTriggerRunById(second.run.id))?.status, "running");

    await database.transitionAgentExecution(second.execution.id, "failed", {
      result: { branch: second.run.configuredTriggerName },
    });
    const secondFinish = await database.completeWorkflowStep(second.execution.id, "failed", {
      branch: second.run.configuredTriggerName,
    });
    assert.deepEqual(
      await database.completeWorkflowStep(second.execution.id, "failed", {
        branch: second.run.configuredTriggerName,
      }),
      secondFinish,
    );
    await handler(trigger);
    await engine.processAvailable();
    assert.equal((await database.findTriggerRunById(second.run.id))?.status, "failed");
    assert.equal(dispatches, 2);
  });

  it("deduplicates delivery, wakeup, and finish transitions", async () => {
    const database = createMemoryDatabase();
    const trigger = await insertTrigger(database, "delivery-duplicate");
    const { handler, engine } = createDurableWorkflowHandler({
      database,
      providers: [provider()],
      dispatchLaunchMachineIntent: async (intent) => ({
        execution: await database.insertAgentExecution({
          id: durableExecutionId(intent),
          organizationId: intent.organizationId,
          projectId: intent.projectId,
          machineId: null,
          triggerId: intent.triggerId,
          triggerContext: intent.triggerContext,
          outputContext: intent.outputContext,
          configurationRevisionId: intent.configurationRevisionId,
          workflowStepRunId: intent.workflowStepRunId!,
          launchIntent: intent,
        }),
      }),
    });
    await handler(trigger);
    await handler(trigger);
    await engine.processAvailable();
    const run = (await database.findTriggerRunsByTriggerId(trigger.triggerId))[0];
    assert.ok(run);
    const step = await database.findWorkflowStepRunByTriggerRun(run.id);
    assert.ok(step);
    const execution = await database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);
    await database.transitionAgentExecution(execution.id, "succeeded", {
      result: { status: "succeeded" },
    });
    const first = await database.completeWorkflowStep(execution.id, "succeeded", {
      status: "succeeded",
    });
    const second = await database.completeWorkflowStep(execution.id, "succeeded", {
      status: "succeeded",
    });
    assert.equal(first?.run.status, "succeeded");
    assert.deepEqual(second, first);
    assert.equal((await database.findAgentExecutionByWorkflowStepRunId(step.id))?.id, execution.id);
  });

  it("allows an expired wakeup lease to be claimed by the next worker", async () => {
    const database = createMemoryDatabase();
    const now = new Date("2026-08-05T12:00:00.000Z");
    const trigger = await insertTrigger(database, "delivery-lease");
    const intent = providerMatch().intent;
    const created = await database.createTriggerRun({
      organizationId: trigger.organizationId,
      projectId: trigger.projectId,
      configurationRevisionId: "config-1",
      triggerId: trigger.triggerId,
      configuredTriggerName: "test-trigger",
      rawPrompt: "raw",
      prompt: "prompt",
      deadlineAt: new Date(now.getTime() + 60_000),
      stepId: "step-one",
      stepRunId: "step-run-one",
      dispatchIntent: intent,
      createdAt: now,
    });
    assert.equal((await database.claimWorkflowWakeup(now, 1_000))?.triggerRunId, created.run.id);
    assert.equal(
      await database.claimWorkflowWakeup(new Date(now.getTime() + 500), 1_000),
      undefined,
    );
    assert.equal(
      (await database.claimWorkflowWakeup(new Date(now.getTime() + 1_001), 1_000))?.triggerRunId,
      created.run.id,
    );
  });

  it("recreates a wakeup after a restart boundary when a terminal execution was not finalized", async () => {
    const database = createMemoryDatabase();
    const trigger = await insertTrigger(database, "delivery-recovery");
    const { handler, engine } = createDurableWorkflowHandler({
      database,
      providers: [provider()],
      dispatchLaunchMachineIntent: async (intent) => ({
        execution: await database.insertAgentExecution({
          id: durableExecutionId(intent),
          organizationId: intent.organizationId,
          projectId: intent.projectId,
          machineId: null,
          triggerId: intent.triggerId,
          triggerContext: intent.triggerContext,
          outputContext: intent.outputContext,
          configurationRevisionId: intent.configurationRevisionId,
          workflowStepRunId: intent.workflowStepRunId!,
          launchIntent: intent,
        }),
      }),
    });
    await handler(trigger);
    await engine.processAvailable();
    const run = (await database.findTriggerRunsByTriggerId(trigger.triggerId))[0];
    assert.ok(run);
    const step = await database.findWorkflowStepRunByTriggerRun(run.id);
    assert.ok(step);
    const execution = await database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);
    await database.transitionAgentExecution(execution.id, "succeeded", {
      result: { status: "succeeded" },
    });
    await database.deleteWorkflowWakeup(run.id);
    await database.recoverWorkflowWakeups(new Date());
    await engine.processAvailable();
    assert.equal((await database.findTriggerRunById(run.id))?.status, "succeeded");
  });
});

function provider() {
  return {
    name: "test",
    eventNames: ["test.event" as const],
    async match() {
      return [providerMatch().match];
    },
  };
}

function providerMatch(triggerName = "test-trigger", stepId = "step-one") {
  const intent = {
    kind: "launch_machine" as const,
    organizationId: "org-1",
    projectId: "00000000-0000-4000-8000-000000000001",
    triggerId: "trigger-placeholder",
    workflowStepRunId: "step-run-one",
    triggerName,
    environmentName: "runner",
    environment: {
      kind: "daemon" as const,
      daemonId: "daemon-1",
      authoredSlug: "runner",
      cwd: "/repo",
    },
    prompt: "prompt",
    agent: { provider: "test", mode: "default" },
    allowOutputs: [],
    timeoutMs: 30_000,
    idleTimeoutMs: 5_000,
    autoArchive: false,
    triggerContext: { provider: "test" },
    outputContext: { provider: "test" },
    configurationRevisionId: "config-1",
    hubConfig: {},
  };
  return {
    intent,
    match: {
      triggerName,
      stepId,
      environmentName: "runner",
      environment: intent.environment,
      prompt: "prompt",
      agent: intent.agent,
      allowOutputs: [],
      timeoutMs: 30_000,
      runTimeoutMs: 60_000,
      idleTimeoutMs: 5_000,
      autoArchive: false,
      triggerContext: intent.triggerContext,
      outputContext: intent.outputContext,
      configurationRevisionId: "config-1",
      hubConfig: {},
    },
  };
}

async function insertTrigger(
  database: ReturnType<typeof createMemoryDatabase>,
  deliveryId: string,
) {
  const trigger = await database.insertTrigger({
    organizationId: "org-1",
    projectId: "00000000-0000-4000-8000-000000000001",
    configurationRevisionId: "config-1",
    deliveryId,
    source: "test.event",
    payload: { prompt: "raw" },
    receivedAt: new Date(),
  });
  return {
    triggerId: trigger.trigger.id,
    organizationId: "org-1",
    projectId: "00000000-0000-4000-8000-000000000001",
    source: "test.event",
    deliveryId,
    payload: { prompt: "raw" },
    receivedAt: new Date(),
    connectionId: null,
    resourceId: null,
  } satisfies DurableTrigger;
}
