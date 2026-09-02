import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { completesAtIdleDeadline } from "./idle-completion.js";
import { missingRequiredOutputs } from "../execution-capabilities/required-outputs.js";

const IDLE_DEADLINE = new Date("2026-08-05T12:00:10.000Z");
const AFTER_IDLE = new Date("2026-08-05T12:00:11.000Z");

describe("completesAtIdleDeadline", () => {
  it("requires at least one emitted output", () => {
    assert.equal(completesAtIdleDeadline({ outputEmissions: {}, launchIntent: null }), false);
    assert.equal(
      completesAtIdleDeadline({ outputEmissions: { "linear.reply": 0 }, launchIntent: null }),
      false,
    );
    assert.equal(
      completesAtIdleDeadline({ outputEmissions: { "linear.reply": 1 }, launchIntent: null }),
      true,
    );
  });

  it("keeps executions that owe a structured output on the timeout path", () => {
    assert.equal(
      completesAtIdleDeadline({
        outputEmissions: { "linear.reply": 1 },
        launchIntent: { outputSchema: { type: "object" }, allowOutputs: [] },
      }),
      false,
    );
  });

  it("applies the finish_execution bar: every required output must have been emitted", () => {
    const allowOutputs = [
      { type: "linear.reply", required: true },
      { type: "github.comment", required: true },
      { type: "slack.message" },
    ];
    assert.equal(
      completesAtIdleDeadline({
        outputEmissions: { "linear.reply": 1, "slack.message": 1 },
        launchIntent: { allowOutputs },
      }),
      false,
      "a missing required output keeps the idle deadline on the timeout path",
    );
    assert.equal(
      completesAtIdleDeadline({
        outputEmissions: { "linear.reply": 1, "github.comment": 1 },
        launchIntent: { allowOutputs },
      }),
      true,
      "optional outputs are not owed",
    );
    assert.equal(
      completesAtIdleDeadline({
        outputEmissions: { "slack.message": 2 },
        launchIntent: { allowOutputs: [{ type: "slack.message" }] },
      }),
      true,
      "without a required output any emission completes the execution",
    );
  });

  it("shares its notion of owed outputs with finish_execution", () => {
    const execution = {
      outputEmissions: { "linear.reply": 1 },
      launchIntent: {
        allowOutputs: [
          { type: "linear.reply", required: true },
          { type: "github.comment", required: true },
        ],
      },
    };
    assert.deepEqual(
      missingRequiredOutputs(execution).map((output) => output.type),
      ["github.comment"],
    );
    assert.equal(completesAtIdleDeadline(execution), false);
  });
});

describe("memory database idle deadline after an emitted output", () => {
  it("completes the step and wakes the run when the idle deadline sweep finds an emitted output", async () => {
    const fixture = await workflowExecution({ emitted: true });

    const recoveries = await fixture.database.recoverWorkflowDeadlines(AFTER_IDLE);

    assert.deepEqual(recoveries, [
      {
        triggerRunId: fixture.runId,
        executionIds: [],
        completedExecutionIds: [fixture.executionId],
      },
    ]);
    const execution = await fixture.database.findAgentExecutionById(fixture.executionId);
    assert.deepEqual(
      { status: execution?.status, result: execution?.result, hubAction: execution?.hubAction },
      { status: "succeeded", result: { status: "succeeded" }, hubAction: null },
    );
    assert.equal(
      (await fixture.database.findWorkflowStepRunById(fixture.stepId))?.status,
      "succeeded",
    );
    assert.equal((await fixture.database.findTriggerRunById(fixture.runId))?.status, "running");
    assert.equal(
      (await fixture.database.claimWorkflowWakeup(AFTER_IDLE, 1_000))?.triggerRunId,
      fixture.runId,
    );
  });

  it("still times out the step when the sweep finds no emitted output", async () => {
    const fixture = await workflowExecution({ emitted: false });

    const recoveries = await fixture.database.recoverWorkflowDeadlines(AFTER_IDLE);

    assert.deepEqual(recoveries, [
      { triggerRunId: fixture.runId, executionIds: [fixture.executionId] },
    ]);
    const execution = await fixture.database.findAgentExecutionById(fixture.executionId);
    assert.deepEqual(execution?.result, { status: "failed", reason: "step_idle_timeout" });
    assert.equal(
      (await fixture.database.findWorkflowStepRunById(fixture.stepId))?.status,
      "timed_out",
    );
    assert.equal((await fixture.database.findTriggerRunById(fixture.runId))?.status, "failed");
  });

  it("still times out the step when every delivery attempt failed", async () => {
    const fixture = await workflowExecution({ emitted: false, failedDeliveries: 3 });

    const recoveries = await fixture.database.recoverWorkflowDeadlines(AFTER_IDLE);

    assert.deepEqual(recoveries, [
      { triggerRunId: fixture.runId, executionIds: [fixture.executionId] },
    ]);
    const execution = await fixture.database.findAgentExecutionById(fixture.executionId);
    assert.deepEqual(execution?.outputEmissions, {}, "failed attempts are not emissions");
    assert.deepEqual(execution?.result, { status: "failed", reason: "step_idle_timeout" });
  });

  it("turns a late completion into a success instead of an idle timeout once an output was emitted", async () => {
    const fixture = await workflowExecution({ emitted: true });

    const transition = await fixture.database.completeWorkflowAgentExecution({
      executionId: fixture.executionId,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded" },
      observedAt: AFTER_IDLE,
    });

    assert.equal(transition.transitioned, true);
    assert.equal(transition.deadlineKind, undefined);
    assert.deepEqual(transition.execution.result, { status: "succeeded" });
    assert.equal(
      (await fixture.database.findWorkflowStepRunById(fixture.stepId))?.status,
      "succeeded",
    );
  });

  it("keeps coercing a late completion into an idle timeout without an emitted output", async () => {
    const fixture = await workflowExecution({ emitted: false });

    const transition = await fixture.database.completeWorkflowAgentExecution({
      executionId: fixture.executionId,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded" },
      observedAt: AFTER_IDLE,
    });

    assert.equal(transition.deadlineKind, "step_idle");
    assert.deepEqual(transition.execution.result, {
      status: "failed",
      reason: "step_idle_timeout",
    });
  });
});

async function workflowExecution(options: { emitted: boolean; failedDeliveries?: number }) {
  const database = createMemoryDatabase({ now: () => AFTER_IDLE });
  const run = (
    await database.createAcceptedTriggerRun({
      organizationId: "org-idle",
      projectId: "project-idle",
      configurationRevisionId: "revision-idle",
      providerEventReceiptId: "receipt-idle",
      configuredTriggerName: "idle",
      prompt: "raw",
      inputs: {},
      triggerContext: { provider: "test" },
      outputContext: { provider: "test" },
      deadlineAt: new Date("2026-08-05T13:00:00.000Z"),
      stepIds: ["step"],
    })
  ).run;
  const step = (await database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
  const execution = await database.insertAgentExecution({
    id: "00000000-0000-4000-8000-0000000000aa",
    organizationId: run.organizationId,
    projectId: run.projectId,
    machineId: null,
    daemonId: "daemon-idle",
    triggerContext: run.triggerContext,
    outputContext: run.outputContext,
    configurationRevisionId: run.configurationRevisionId,
    workflowStepRunId: step.id,
    deadlineAt: new Date("2026-08-05T12:30:00.000Z"),
    idleDeadlineAt: IDLE_DEADLINE,
  });
  await database.linkWorkflowStepRunExecution(step.id, execution.id);
  if (options.emitted) {
    const startedAt = new Date("2026-08-05T12:00:05.000Z");
    const attempt = await database.beginAgentExecutionOutput(
      execution.id,
      "linear.reply",
      undefined,
      startedAt,
    );
    assert.ok(attempt !== undefined);
    await database.completeAgentExecutionOutput(execution.id, attempt.id, startedAt);
  }
  for (let failed = 0; failed < (options.failedDeliveries ?? 0); failed += 1) {
    const startedAt = new Date("2026-08-05T12:00:05.000Z");
    const attempt = await database.beginAgentExecutionOutput(
      execution.id,
      "linear.reply",
      undefined,
      startedAt,
    );
    assert.ok(attempt !== undefined);
    await database.failAgentExecutionOutput(execution.id, attempt.id, startedAt);
  }
  return { database, runId: run.id, stepId: step.id, executionId: execution.id };
}
