import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import {
  compileHubConfig,
  compiledConfigurationHash,
  type CompiledHubConfig,
} from "../config/compiler.js";
import { durableExecutionId } from "../daemons/lifecycle.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database, DurableTrigger } from "../db/types.js";
import type { AcceptedTriggerProviderMatch } from "../triggers/index.js";
import { parseInvocation } from "../triggers/invocation.js";
import { createDurableWorkflowHandler } from "./engine.js";

describe("durable multi-step workflow engine", () => {
  it("skips classification for deterministic input and launches only the matching branch", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("repo=hub work"));
    assert.equal((await fixture.database.findTriggerRunsByTriggerId(fixture.triggerId)).length, 1);
    await engine.processAvailable();

    let run = (await fixture.database.findTriggerRunsByTriggerId(fixture.triggerId))[0];
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
    const run = (await fixture.database.findTriggerRunsByTriggerId(fixture.triggerId))[0]!;
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
    const run = (await fixture.database.findTriggerRunsByTriggerId(fixture.triggerId))[0]!;
    assert.equal(run.status, "failed");
    assert.match(run.failureReason ?? "", /unavailable|evaluation/iu);
    assert.deepEqual(dispatches, []);
  });

  it("fails a classifier without launching downstream work", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("investigate"));
    await engine.processAvailable();
    const run = (await fixture.database.findTriggerRunsByTriggerId(fixture.triggerId))[0]!;
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
    const run = (await fixture.database.findTriggerRunsByTriggerId(fixture.triggerId))[0]!;
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
    const run = (await fixture.database.findTriggerRunsByTriggerId(fixture.triggerId))[0]!;
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

      const run = (await fixture.database.findTriggerRunsByTriggerId(fixture.triggerId))[0]!;
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
      const run = (await fixture.database.findTriggerRunsByTriggerId(fixture.triggerId))[0]!;
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
});

interface Fixture {
  database: Database;
  triggerId: string;
  revisionId: string;
  configuration: CompiledHubConfig;
  trigger(message: string): DurableTrigger;
}

async function workflowFixture(
  options: { unavailableValue?: boolean; terminalRecovery?: boolean } = {},
): Promise<Fixture> {
  const database = createMemoryDatabase({ organizationIds: ["org-1"] });
  const project = await database.createProject({
    organizationId: "org-1",
    name: "Workflow",
    slug: randomUUID(),
    createdByUserId: "user-1",
  });
  const raw = options.terminalRecovery
    ? terminalRecoveryConfiguration()
    : baseConfiguration(options);
  const compiled = compileHubConfig(raw);
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
  const trigger = await database.insertTrigger({
    organizationId: "org-1",
    projectId: project.id,
    configurationRevisionId: revision.id,
    deliveryId: randomUUID(),
    source: "manual.run",
    payload: {},
    receivedAt: new Date(),
  });
  return {
    database,
    triggerId: trigger.trigger.id,
    revisionId: revision.id,
    configuration,
    trigger(message) {
      return {
        triggerId: trigger.trigger.id,
        organizationId: "org-1",
        projectId: project.id,
        source: "manual.run",
        deliveryId: trigger.trigger.deliveryId,
        payload: { input: message },
        receivedAt: new Date(),
        connectionId: null,
        resourceId: null,
      };
    },
  };
}

function engineFor(
  fixture: Fixture,
  dispatches: string[],
  beforeDispatch?: (intent: { prompt: string }) => Promise<void>,
) {
  return createDurableWorkflowHandler({
    database: fixture.database,
    providers: [providerMatch(fixture.configuration, fixture.revisionId)],
    dispatchLaunchMachineIntent: async (intent) => {
      await beforeDispatch?.(intent);
      dispatches.push(dispatchLabel(intent));
      return {
        execution: await fixture.database.insertAgentExecution({
          id: durableExecutionId(intent),
          organizationId: intent.organizationId,
          projectId: intent.projectId,
          machineId: null,
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
