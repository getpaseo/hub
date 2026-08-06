import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, vi } from "vitest";
import {
  compileHubConfig,
  compiledConfigurationHash,
  type CompiledHubConfig,
} from "../config/compiler.js";
import {
  hashPromptPartialContent,
  type ResolvedPromptPartials,
} from "../config/prompt-partials.js";
import { createMemoryDatabase } from "../db/memory.js";
import type {
  Database,
  DurableProviderEvent,
  ProviderEventReceiptRecord,
  TriggerRunRecord,
} from "../db/types.js";
import type { AcceptedTriggerProviderMatch } from "../triggers/index.js";
import { parseInvocation } from "../triggers/invocation.js";
import { createDurableWorkflowHandler } from "./engine.js";

describe("durable multi-step workflow engine", () => {
  it("logs an initial recovery rejection and retries on the next interval", async () => {
    vi.useFakeTimers();
    const fixture = await workflowFixture();
    const recovery = vi
      .spyOn(fixture.database, "recoverWorkflowDeadlines")
      .mockRejectedValueOnce(new Error("recovery unavailable"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const { engine } = createDurableWorkflowHandler({
      database: fixture.database,
      providers: [providerMatch(fixture.configuration, fixture.revisionId)],
      workerIntervalMs: 10,
      dispatchLaunchMachineIntent: async (intent) => {
        const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
          intent.workflowStepRunId!,
        );
        if (execution === undefined) throw new Error("workflow execution was not persisted");
        return { execution };
      },
    });
    try {
      engine.start();
      assert.equal(recovery.mock.calls.length, 1);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      assert.equal(recovery.mock.calls.length, 2);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await engine.stop();
      vi.useRealTimers();
    }
  });

  it.each([
    ["succeeded", "succeeded"],
    ["failed", "failed"],
  ] as const)(
    "notifies the provider once when the whole workflow %s",
    async (stepStatus, expected) => {
      const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
      const terminalStatuses: string[] = [];
      const { handler, engine } = engineFor(fixture, [], undefined, undefined, async (run) => {
        terminalStatuses.push(run.status);
      });
      await handler(fixture.trigger("run"));
      await engine.processAvailable();
      const run = (
        await fixture.database.findTriggerRunsByProviderEventReceiptId(
          fixture.providerEventReceiptId,
        )
      )[0]!;
      let steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
      const first = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[0]!.id);
      assert.ok(first);
      await fixture.database.transitionAgentExecution(first.id, stepStatus, {
        result: { status: stepStatus },
      });
      await engine.processAvailable();
      if (stepStatus === "succeeded") {
        assert.deepEqual(terminalStatuses, []);
        steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
        const second = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[1]!.id);
        assert.ok(second);
        await fixture.database.transitionAgentExecution(second.id, "succeeded", {
          result: { status: "succeeded" },
        });
        await engine.processAvailable();
      }
      await engine.processAvailable();
      assert.deepEqual(terminalStatuses, [expected]);
    },
  );

  it("retries a failed workflow terminal outbox delivery", async () => {
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    let now = new Date("2026-08-06T12:00:00.000Z");
    const delivered: string[] = [];
    let failFirst = true;
    const { handler, engine } = createDurableWorkflowHandler({
      database: fixture.database,
      providers: [providerMatch(fixture.configuration, fixture.revisionId)],
      now: () => now,
      leaseMs: 1_000,
      dispatchLaunchMachineIntent: async (intent) => {
        const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
          intent.workflowStepRunId!,
        );
        if (execution === undefined) throw new Error("workflow execution was not persisted");
        return { execution };
      },
      onWorkflowRunTerminal: async (run) => {
        delivered.push(run.id);
        if (failFirst) {
          failFirst = false;
          throw new Error("provider unavailable");
        }
      },
    });
    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const first = await fixture.database.findAgentExecutionByWorkflowStepRunId(
      (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!.id,
    );
    assert.ok(first);
    await fixture.database.completeWorkflowAgentExecution({
      executionId: first.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded" },
      observedAt: now,
    });
    await fixture.database.wakeWorkflowRun(run.id, now);
    await engine.processAvailable();
    const secondStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[1]!;
    const second = await fixture.database.findAgentExecutionByWorkflowStepRunId(secondStep.id);
    assert.ok(second);
    await fixture.database.completeWorkflowAgentExecution({
      executionId: second.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded" },
      observedAt: now,
    });
    await fixture.database.wakeWorkflowRun(run.id, now);

    await engine.processAvailable();
    assert.deepEqual(delivered, [run.id]);
    const failedDelivery = await fixture.database.findTriggerRunById(run.id);
    assert.equal(
      failedDelivery?.outcome === "accepted"
        ? failedDelivery.terminalNotificationDeliveredAt
        : "missing",
      null,
    );

    now = new Date("2026-08-06T12:00:01.001Z");
    await engine.processAvailable();
    assert.deepEqual(delivered, [run.id, run.id]);
    const completedDelivery = await fixture.database.findTriggerRunById(run.id);
    assert.equal(
      completedDelivery?.outcome === "accepted"
        ? completedDelivery.terminalNotificationDeliveredAt !== null
        : false,
      true,
    );
  });

  it("keeps a shared accepted receipt replayable when one project route has no workflow match", async () => {
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    const secondProject = await fixture.database.createProject({
      organizationId: "org-1",
      name: "Other Workflow",
      slug: randomUUID(),
      createdByUserId: "user-1",
    });
    const secondRevision = await fixture.database.insertProjectConfigurationRevision({
      projectId: secondProject.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: fixture.configuration,
      contentHash: compiledConfigurationHash(fixture.configuration),
      createdByUserId: "user-1",
    });
    await fixture.database.activateProjectConfigurationRevision(
      secondProject.id,
      secondRevision.id,
      [],
    );
    const receipt = await fixture.database.findProviderEventReceiptById(
      fixture.providerEventReceiptId,
    );
    assert.ok(receipt);
    setAcceptedRoutes(fixture.database, {
      ...receipt,
      acceptedRoutes: [
        {
          projectId: fixture.projectId,
          configurationRevisionId: fixture.revisionId,
          connectionId: null,
          resourceId: null,
        },
        {
          projectId: secondProject.id,
          configurationRevisionId: secondRevision.id,
          connectionId: null,
          resourceId: null,
        },
      ],
    });
    const { handler } = createDurableWorkflowHandler({
      database: fixture.database,
      providers: [
        {
          name: "manual",
          eventNames: ["manual.run"] as const,
          async match(external) {
            if (external.projectId === fixture.projectId) return [];
            throw new Error("enqueue unavailable");
          },
        },
      ],
    });

    await assert.rejects(
      handler({
        ...fixture.trigger("run"),
        projectId: secondProject.id,
        configurationRevisionId: secondRevision.id,
      }),
      /enqueue unavailable/iu,
    );
    assert.deepEqual(await handler(fixture.trigger("run")), {
      providerEventReceiptId: fixture.providerEventReceiptId,
    });
    const replay = await fixture.database.persistManualEvent({
      organizationId: "org-1",
      projectId: fixture.projectId,
      deliveryId: fixture.deliveryId,
      source: "manual.run",
      payload: {},
      receivedAt: new Date(),
    });
    assert.equal(replay.status, "accepted");
    const replayReceipt = await fixture.database.findProviderEventReceiptById(
      fixture.providerEventReceiptId,
    );
    assert.equal(replayReceipt?.droppedReason, null);
  });

  it("launches the exact committed partial content with inline-equivalent interpolation", async () => {
    const content = "Committed partial for ${{ paseo.prompt }} / ${{ paseo.inputs.repo }}";
    const fixture = await workflowFixture({
      rawConfiguration: partialRuntimeConfiguration(),
      resolvedPromptPartials: new Map([
        [
          ".paseo/partials/instructions.md",
          {
            path: ".paseo/partials/instructions.md",
            content,
            contentHash: hashPromptPartialContent(content),
          },
        ],
      ]),
    });
    const dispatches: string[] = [];
    const prompts: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, async (intent) => {
      prompts.push(intent.prompt);
    });

    await handler(fixture.trigger("repo=hub request"));
    await engine.processAvailable();

    assert.deepEqual(dispatches, ["unknown"]);
    assert.deepEqual(prompts, ["Committed partial for request / hub\nInline request / hub"]);
  });

  it("skips classification for deterministic input and launches only the matching branch", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("repo=hub work"));
    assert.equal(
      (
        await fixture.database.findTriggerRunsByProviderEventReceiptId(
          fixture.providerEventReceiptId,
        )
      ).length,
      1,
    );
    await engine.processAvailable();

    let run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0];
    assert.ok(run && run.outcome === "accepted");
    let steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.deepEqual(
      steps.map((step) => [step.stepId, step.status]),
      [
        ["classify", "skipped"],
        ["work-hub", "running"],
        ["work-paseo", "pending"],
      ],
    );
    assert.deepEqual(dispatches, ["work-hub"]);

    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[1]!.id);
    assert.ok(execution);
    await fixture.database.transitionAgentExecution(execution.id, "succeeded", {
      result: { status: "succeeded" },
    });
    await fixture.database.completeWorkflowStep(execution.id, "succeeded", { status: "succeeded" });
    await engine.processAvailable();
    run = await fixture.database.findTriggerRunById(run.id);
    assert.equal(run?.status, "succeeded");
    steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.deepEqual(
      steps.map((step) => [step.stepId, step.status]),
      [
        ["classify", "skipped"],
        ["work-hub", "succeeded"],
        ["work-paseo", "skipped"],
      ],
    );
  });

  it("runs classification when input is absent and composes its validated output", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("investigate"));
    await engine.processAvailable();
    assert.deepEqual(dispatches, ["classify"]);
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    const classifier = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[0]!.id);
    assert.ok(classifier);

    await fixture.database.completeWorkflowAgentExecution({
      executionId: classifier.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded", output: { repo: "paseo" } },
      stepOutput: { repo: "paseo" },
      completedByAgent: true,
    });
    await engine.processAvailable();
    assert.deepEqual(dispatches, ["classify", "work-paseo"]);
    assert.equal(
      (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[1]!.status,
      "skipped",
    );
  });

  it("fails when an unavailable output is evaluated outside a short-circuited branch", async () => {
    const fixture = await workflowFixture({ unavailableValue: true });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("repo=hub work"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.status, "failed");
    assert.match(run.failureReason ?? "", /unavailable|evaluation/iu);
    assert.deepEqual(dispatches, []);
  });

  it("fails prompt interpolation that reads a skipped prior step output without dispatching", async () => {
    const fixture = await workflowFixture({ rawConfiguration: skippedOutputPromptConfiguration() });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    await engine.processAvailable();

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.equal(run.status, "failed");
    assert.match(run.failureReason ?? "", /steps\.classify\.outputs\.repo|unavailable/iu);
    assert.deepEqual(
      steps.map((step) => [step.stepId, step.status]),
      [
        ["classify", "skipped"],
        ["work", "failed"],
      ],
    );
    assert.deepEqual(dispatches, []);
  });

  it("persists final values composed from a one-step structured output", async () => {
    const fixture = await workflowFixture({ rawConfiguration: finalValueConfiguration() });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("run"));
    await engine.processAvailable();

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const step = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);
    await fixture.database.completeWorkflowAgentExecution({
      executionId: execution.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded", output: { decision: "ship" } },
      stepOutput: { decision: "ship" },
      completedByAgent: true,
    });
    await engine.processAvailable();

    const completed = await fixture.database.findTriggerRunById(run.id);
    assert.equal(completed?.status, "succeeded");
    assert.deepEqual(completed?.values, { final_decision: "ship" });
  });

  it("fails a classifier without launching downstream work", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("investigate"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    const classifier = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[0]!.id);
    assert.ok(classifier);
    await fixture.database.transitionAgentExecution(classifier.id, "failed", {
      result: { reason: "classifier_failed" },
    });
    await fixture.database.completeWorkflowStep(
      classifier.id,
      "failed",
      { reason: "classifier_failed" },
      "classifier_failed",
    );
    await engine.processAvailable();
    assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "failed");
    assert.deepEqual(dispatches, ["classify"]);
  });

  it("times out a classifier without launching downstream work", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("investigate"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    const classifier = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[0]!.id);
    assert.ok(classifier);
    await fixture.database.transitionAgentExecution(classifier.id, "failed", {
      result: { reason: "timed_out" },
    });
    await fixture.database.completeWorkflowStep(
      classifier.id,
      "timed_out",
      { reason: "timed_out" },
      "timed_out",
    );
    await engine.processAvailable();
    assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "timed_out");
    assert.deepEqual(dispatches, ["classify"]);
  });

  it("restarts after structured completion and creates exactly one downstream execution", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const first = engineFor(fixture, dispatches);
    await first.handler(fixture.trigger("investigate"));
    await first.engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const classifierStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const classifier = await fixture.database.findAgentExecutionByWorkflowStepRunId(
      classifierStep.id,
    );
    assert.ok(classifier);
    await fixture.database.completeWorkflowAgentExecution({
      executionId: classifier.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded", output: { repo: "hub" } },
      stepOutput: { repo: "hub" },
      completedByAgent: true,
    });

    const restarted = engineFor(fixture, dispatches);
    await restarted.engine.processAvailable();
    await fixture.database.wakeWorkflowRun(run.id, new Date());
    await restarted.engine.processAvailable();
    assert.deepEqual(dispatches, ["classify", "work-hub"]);
    assert.equal(
      (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id)).filter(
        (step) => step.agentExecutionId !== null,
      ).length,
      2,
    );
  });

  it.each([
    { terminalStatus: "succeeded" as const, expectedRunStatus: "running" as const },
    { terminalStatus: "failed" as const, expectedRunStatus: "failed" as const },
  ])(
    "reconciles a terminal $terminalStatus execution before evaluating downstream work",
    async ({ terminalStatus, expectedRunStatus }) => {
      const fixture = await workflowFixture({ terminalRecovery: true });
      const dispatches: string[] = [];
      const first = engineFor(fixture, dispatches);
      await first.handler(fixture.trigger("repo=hub work"));
      await first.engine.processAvailable();

      const run = (
        await fixture.database.findTriggerRunsByProviderEventReceiptId(
          fixture.providerEventReceiptId,
        )
      )[0]!;
      const firstStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
      const firstExecution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
        firstStep.id,
      );
      assert.ok(firstExecution);
      assert.deepEqual(dispatches, ["first"]);

      await fixture.database.transitionAgentExecution(firstExecution.id, terminalStatus, {
        result: { status: terminalStatus },
      });

      const restarted = engineFor(fixture, dispatches, async (intent) => {
        if (intent.prompt !== "Downstream") return;
        assert.equal(
          (await fixture.database.findWorkflowStepRunById(firstStep.id))?.status,
          terminalStatus,
        );
      });
      await restarted.engine.processAvailable();
      await restarted.engine.processAvailable();

      assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, expectedRunStatus);
      assert.equal(
        (await fixture.database.findWorkflowStepRunById(firstStep.id))?.status,
        terminalStatus,
      );
      assert.deepEqual(
        dispatches,
        terminalStatus === "succeeded" ? ["first", "downstream"] : ["first"],
      );
    },
  );

  it.each([
    { executionStatus: "succeeded" as const, stepStatus: "succeeded" as const },
    { executionStatus: "failed" as const, stepStatus: "failed" as const },
    { executionStatus: "failed" as const, stepStatus: "timed_out" as const },
  ])(
    "atomically completes workflow-owned $stepStatus agent executions in memory",
    async ({ executionStatus, stepStatus }) => {
      const fixture = await workflowFixture({ terminalRecovery: true });
      const dispatches: string[] = [];
      const { handler, engine } = engineFor(fixture, dispatches);
      await handler(fixture.trigger("repo=hub work"));
      await engine.processAvailable();
      const run = (
        await fixture.database.findTriggerRunsByProviderEventReceiptId(
          fixture.providerEventReceiptId,
        )
      )[0]!;
      const firstStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
      const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(firstStep.id);
      assert.ok(execution);

      const terminal = await fixture.database.completeWorkflowAgentExecution({
        executionId: execution.id,
        executionStatus,
        stepStatus,
        result: { status: executionStatus, reason: stepStatus },
        stepOutput: { status: stepStatus },
      });
      const duplicate = await fixture.database.completeWorkflowAgentExecution({
        executionId: execution.id,
        executionStatus,
        stepStatus,
        result: { status: executionStatus, reason: "duplicate" },
        stepOutput: { status: "duplicate" },
      });

      assert.equal(terminal.transitioned, true);
      assert.equal(duplicate.transitioned, false);
      assert.equal(
        (await fixture.database.findAgentExecutionById(execution.id))?.status,
        executionStatus,
      );
      assert.equal(
        (await fixture.database.findWorkflowStepRunById(firstStep.id))?.status,
        stepStatus,
      );
      assert.equal(
        (await fixture.database.findTriggerRunById(run.id))?.status,
        stepStatus === "succeeded" ? "running" : stepStatus,
      );
      await engine.processAvailable();
      assert.deepEqual(
        dispatches,
        stepStatus === "succeeded" ? ["first", "downstream"] : ["first"],
      );
    },
  );

  it("persists step hard and idle deadlines capped by the whole-run deadline", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, undefined, () => now);

    await handler(fixture.trigger("run"));
    await engine.processAvailable();

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const step = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);
    assert.equal(execution.deadlineAt?.toISOString(), "2026-08-06T12:01:00.000Z");
    assert.equal(execution.idleDeadlineAt?.toISOString(), "2026-08-06T12:00:20.000Z");

    assert.equal(run.deadlineAt.toISOString(), "2026-08-06T12:02:00.000Z");
  });

  it("times out a live step when the whole-run deadline expires", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({
      rawConfiguration: deadlineConfiguration({ idleTimeout: "1m" }),
    });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, undefined, () => now);

    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const step = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);

    now = new Date("2026-08-06T12:02:00.000Z");
    await engine.processAvailable();

    assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "timed_out");
    assert.equal((await fixture.database.findWorkflowStepRunById(step.id))?.status, "timed_out");
    assert.equal((await fixture.database.findAgentExecutionById(execution.id))?.status, "failed");
  });

  it("fails a step at its hard deadline without extending the run", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({
      rawConfiguration: deadlineConfiguration({ idleTimeout: "1m" }),
    });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, undefined, () => now);

    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    now = new Date("2026-08-06T12:01:00.000Z");
    await engine.processAvailable();

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const step = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    assert.equal(run.status, "failed");
    assert.equal(run.deadlineKind, "step_hard");
    assert.equal(step.status, "timed_out");
    assert.equal(step.deadlineKind, "step_hard");
    assert.equal(dispatches.length, 1);
  });

  it("refreshes only the persisted idle deadline for a live workflow step", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, undefined, () => now);

    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const step = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);
    const hardDeadline = execution.deadlineAt;

    now = new Date("2026-08-06T12:00:10.000Z");
    const refreshed = await fixture.database.setAgentExecutionIdleDeadline(
      execution.id,
      new Date("2026-08-06T12:00:30.000Z"),
      now,
      now,
    );
    assert.equal(refreshed.deadlineAt?.getTime(), hardDeadline?.getTime());
    assert.equal(refreshed.idleDeadlineAt?.toISOString(), "2026-08-06T12:00:30.000Z");
    assert.equal(
      (await fixture.database.findWorkflowStepRunById(step.id))?.idleDeadlineAt?.toISOString(),
      "2026-08-06T12:00:30.000Z",
    );
  });

  it("does not dispatch a later step after the whole-run deadline between steps", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, undefined, () => now);

    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const first = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const firstExecution = await fixture.database.findAgentExecutionByWorkflowStepRunId(first.id);
    assert.ok(firstExecution);
    await fixture.database.transitionAgentExecution(firstExecution.id, "succeeded", {
      result: { status: "succeeded" },
    });
    await fixture.database.completeWorkflowStep(firstExecution.id, "succeeded", {
      status: "succeeded",
    });

    now = new Date("2026-08-06T12:02:00.000Z");
    await engine.processAvailable();

    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.equal(dispatches.length, 1);
    assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "timed_out");
    assert.equal(steps[1]?.status, "timed_out");
    assert.equal(steps[1]?.deadlineKind, "whole_run");
  });

  it("wins a completion-at-deadline race with the deadline transition", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({
      rawConfiguration: deadlineConfiguration({ idleTimeout: "1m" }),
    });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, undefined, () => now);

    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const step = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);
    now = execution.deadlineAt!;

    const completion = await fixture.database.completeWorkflowAgentExecution({
      executionId: execution.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded" },
      observedAt: now,
    });
    assert.equal(completion.deadlineKind, "step_hard");
    assert.equal(completion.execution.status, "failed");
    assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "failed");
  });
});

interface Fixture {
  database: Database;
  providerEventReceiptId: string;
  deliveryId: string;
  projectId: string;
  revisionId: string;
  configuration: CompiledHubConfig;
  trigger(message: string): DurableProviderEvent;
}

async function workflowFixture(
  options: {
    unavailableValue?: boolean;
    terminalRecovery?: boolean;
    rawConfiguration?: Record<string, unknown>;
    resolvedPromptPartials?: ResolvedPromptPartials;
  } = {},
): Promise<Fixture> {
  const database = createMemoryDatabase({ organizationIds: ["org-1"] });
  const project = await database.createProject({
    organizationId: "org-1",
    name: "Workflow",
    slug: randomUUID(),
    createdByUserId: "user-1",
  });
  const raw =
    options.rawConfiguration ??
    (options.terminalRecovery ? terminalRecoveryConfiguration() : baseConfiguration(options));
  const compiled = compileHubConfig(
    raw,
    options.resolvedPromptPartials === undefined
      ? {}
      : { resolvedPromptPartials: options.resolvedPromptPartials },
  );
  const configuration: CompiledHubConfig = {
    environments: compiled.environments.map((environment) => {
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
    triggers: compiled.triggers,
  };
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: configuration,
    contentHash: compiledConfigurationHash(configuration),
    createdByUserId: "user-1",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
  const receipt = await database.persistManualEvent({
    organizationId: "org-1",
    projectId: project.id,
    deliveryId: randomUUID(),
    source: "manual.run",
    payload: {},
    receivedAt: new Date(),
  });
  if (receipt.status !== "accepted") throw new Error("workflow receipt was not accepted");
  return {
    database,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    deliveryId: receipt.event.deliveryId,
    projectId: project.id,
    revisionId: revision.id,
    configuration,
    trigger(message) {
      return {
        providerEventReceiptId: receipt.event.providerEventReceiptId,
        organizationId: "org-1",
        projectId: project.id,
        configurationRevisionId: revision.id,
        source: "manual.run",
        deliveryId: receipt.event.deliveryId,
        payload: { input: message },
        receivedAt: new Date(),
        connectionId: null,
        resourceId: null,
      };
    },
  };
}

function setAcceptedRoutes(database: Database, receipt: ProviderEventReceiptRecord): void {
  const receipts: unknown = Reflect.get(database, "providerEventReceipts");
  if (!(receipts instanceof Map)) throw new Error("memory receipt store unavailable");
  receipts.set(receipt.id, receipt);
}

function partialRuntimeConfiguration(): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "partial-request",
        on: "manual.run",
        max_runtime: "1h",
        inputs: { repo: { type: "string", choices: ["hub"] } },
        steps: [
          {
            id: "work-hub",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [
              { include: "instructions.md" },
              { text: "Inline ${{ paseo.prompt }} / ${{ paseo.inputs.repo }}" },
            ],
          },
        ],
      },
    ],
  };
}

function engineFor(
  fixture: Fixture,
  dispatches: string[],
  beforeDispatch?: (intent: { prompt: string }) => Promise<void>,
  now?: () => Date,
  onWorkflowRunTerminal?: (run: TriggerRunRecord) => Promise<void>,
) {
  return createDurableWorkflowHandler({
    database: fixture.database,
    providers: [providerMatch(fixture.configuration, fixture.revisionId)],
    ...(now === undefined ? {} : { now }),
    ...(onWorkflowRunTerminal === undefined ? {} : { onWorkflowRunTerminal }),
    dispatchLaunchMachineIntent: async (intent) => {
      await beforeDispatch?.(intent);
      dispatches.push(dispatchLabel(intent));
      const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
        intent.workflowStepRunId!,
      );
      if (execution === undefined) throw new Error("workflow execution was not persisted");
      return {
        execution,
      };
    },
  });
}

function deadlineConfiguration(options: { idleTimeout?: string } = {}): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "deadline-route",
        on: "manual.run",
        max_runtime: "2m",
        steps: [
          {
            id: "first",
            environment: "runner",
            max_runtime: "1m",
            idle_timeout: options.idleTimeout ?? "20s",
            agent: { provider: "codex" },
            prompt: [{ text: "run" }],
          },
          {
            id: "second",
            environment: "runner",
            max_runtime: "1m",
            idle_timeout: options.idleTimeout ?? "20s",
            agent: { provider: "codex" },
            prompt: [{ text: "run" }],
          },
        ],
      },
    ],
  };
}

function skippedOutputPromptConfiguration(): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "skipped-output-prompt",
        on: "manual.run",
        max_runtime: "1h",
        steps: [
          {
            id: "classify",
            if: "${{ false }}",
            environment: "runner",
            max_runtime: "2m",
            idle_timeout: "30s",
            agent: { provider: "codex" },
            prompt: [{ text: "Classify" }],
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["repo"],
                properties: { repo: { enum: ["hub"] } },
              },
            },
          },
          {
            id: "work",
            if: "${{ true }}",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Repo ${{ steps.classify.outputs.repo }}" }],
          },
        ],
      },
    ],
  };
}

function finalValueConfiguration(): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "final-value",
        on: "manual.run",
        max_runtime: "1h",
        values: {
          final_decision: "${{ steps.decide.outputs.decision }}",
        },
        steps: [
          {
            id: "decide",
            environment: "runner",
            max_runtime: "2m",
            idle_timeout: "30s",
            agent: { provider: "codex" },
            prompt: [{ text: "Decide" }],
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["decision"],
                properties: { decision: { enum: ["ship"] } },
              },
            },
          },
        ],
      },
    ],
  };
}

function providerMatch(configuration: CompiledHubConfig, revisionId: string) {
  return {
    name: "manual",
    eventNames: ["manual.run"] as const,
    async match(external): Promise<readonly AcceptedTriggerProviderMatch[]> {
      const trigger = configuration.triggers[0]!;
      const input =
        isRecord(external.payload) && typeof external.payload["input"] === "string"
          ? external.payload["input"]
          : "";
      const invocation = parseInvocation(input, trigger.inputs);
      if (invocation.status !== "accepted")
        throw new Error("test invocation unexpectedly rejected");
      return [
        {
          triggerName: trigger.name,
          triggerContext: { provider: "manual" },
          outputContext: { provider: "manual" },
          configurationRevisionId: revisionId,
          hubConfig: configuration,
          invocation,
        },
      ];
    },
  } satisfies import("../triggers/index.js").TriggerProvider;
}

function baseConfiguration(options: { unavailableValue?: boolean }): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "route-request",
        on: "manual.run",
        max_runtime: "1h",
        inputs: { repo: { type: "string", choices: ["paseo", "hub"] } },
        values: {
          repo:
            options.unavailableValue === true
              ? "${{ steps.classify.outputs.repo }}"
              : "${{ paseo.inputs.repo ?? steps.classify.outputs.repo }}",
        },
        steps: [
          {
            id: "classify",
            if: "${{ paseo.inputs.repo == null }}",
            environment: "runner",
            max_runtime: "2m",
            idle_timeout: "30s",
            agent: { provider: "codex" },
            prompt: [{ text: "Classify" }],
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["repo"],
                properties: { repo: { enum: ["paseo", "hub"] } },
              },
            },
          },
          {
            id: "work-hub",
            if: "${{ values.repo == 'hub' }}",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Work hub" }],
          },
          {
            id: "work-paseo",
            if: "${{ values.repo == 'paseo' }}",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Work paseo" }],
          },
        ],
      },
    ],
  };
}

function terminalRecoveryConfiguration(): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "terminal-recovery",
        on: "manual.run",
        max_runtime: "1h",
        inputs: { repo: { type: "string", choices: ["hub"] } },
        steps: [
          {
            id: "first",
            environment: "runner",
            max_runtime: "2m",
            idle_timeout: "30s",
            agent: { provider: "codex" },
            prompt: [{ text: "First" }],
          },
          {
            id: "downstream",
            if: "${{ paseo.inputs.repo == 'hub' }}",
            environment: "runner",
            max_runtime: "2m",
            idle_timeout: "30s",
            agent: { provider: "codex" },
            prompt: [{ text: "Downstream" }],
          },
        ],
      },
    ],
  };
}

function dispatchLabel(intent: {
  workflowStepRunId?: string;
  triggerName: string;
  prompt: string;
}): string {
  if (intent.workflowStepRunId === undefined) return "missing";
  if (intent.prompt === "First") return "first";
  if (intent.prompt === "Downstream") return "downstream";
  if (intent.triggerName !== "route-request") return "unknown";
  if (intent.prompt.startsWith("Classify")) return "classify";
  return intent.prompt.includes("paseo") ? "work-paseo" : "work-hub";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
