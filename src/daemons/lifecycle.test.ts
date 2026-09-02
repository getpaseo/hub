import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { deriveAgentExecutionCompletionToken } from "../agent-executions/completion-token.js";
import { createMemoryDatabase } from "../db/memory.js";
import type {
  DaemonExecutionControlOptions,
  DaemonEventHandler,
  DaemonEvent,
  DaemonConnection,
} from "./protocol.js";
import {
  AgentExecutionCompletionFailure,
  createDaemonDispatchLifecycle,
  DaemonDispatchFailure,
  type DaemonDispatchLifecycle,
  type ExecutionDeadlineClock,
} from "./lifecycle.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { OutputExecutorRegistry, replyOutputTool } from "../execution-capabilities/outputs.js";
import { createDurableWorkflowHandler } from "../workflows/engine.js";
import type { TriggerProvider } from "../triggers/index.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import type { DaemonRecord } from "../db/types.js";
import { createLogger, serializeError } from "../logger.js";
import { assertOneFailure, FailureLogStream } from "../test-utils/failure-logs.js";

const DAEMON_ID = "daemon-ack-test";
const AGENT_ID = "agent-ack-test";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const ACKNOWLEDGED_AT = new Date("2026-01-01T00:00:01.000Z");

describe("durable Hub action acknowledgement state", () => {
  it("keeps the classified dispatch code in redacted error logs", () => {
    const diagnostic = serializeError(
      new DaemonDispatchFailure("github_authority_unavailable", {
        cause: Object.assign(new Error("credential detail must not be logged"), {
          code: "github_authority_unavailable",
        }),
      }),
    );

    assert.equal(diagnostic["code"], "github_authority_unavailable");
    const cause = diagnostic["cause"];
    assert.ok(typeof cause === "object" && cause !== null);
    assert.equal(Reflect.get(cause, "code"), "github_authority_unavailable");
    assert.equal(JSON.stringify(diagnostic).includes("credential detail"), false);
  });

  it("logs a daemon execution recovery failure exactly once", async () => {
    const canary = "daemon-lifecycle-secret-4c09";
    const database = createMemoryDatabase();
    const daemon = daemonRecord();
    const executionId = "00000000-0000-4000-8000-0000000000f1";
    await database.insertAgentExecution({
      id: executionId,
      organizationId: "organization-lifecycle-log",
      projectId: "project-lifecycle-log",
      machineId: null,
      daemonId: daemon.id,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: "revision-lifecycle-log",
    });
    vi.spyOn(database, "findAgentExecutionById").mockRejectedValueOnce(new Error(canary));
    const stream = new FailureLogStream();
    const lifecycle = createDaemonDispatchLifecycle({
      database,
      connectionForDaemon: () => new AcknowledgementConnection(),
      publicBaseUrl: "http://hub.test",
      test: { logger: createLogger(stream) },
    });

    await lifecycle.recoverDaemon(daemon);

    assertOneFailure(stream, {
      operation: "daemon.execution.recover",
      component: "daemons",
      canary,
    });
    await lifecycle.stop();
  });

  it("owns a rejected daemon event without leaking it to the process", async () => {
    const fixture = await acknowledgementFixture();
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    vi.spyOn(fixture.database, "recordAgentExecutionHubAcknowledgement").mockRejectedValueOnce(
      new Error("database event write failed"),
    );

    try {
      await fixture.connection.emitObserved(turnCompleted());
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it("defers workflow-owned terminal provider failure notification to the outbox", async () => {
    const database = createMemoryDatabase();
    let failureHooks = 0;
    const provider: TriggerProvider = {
      name: "test",
      eventNames: ["manual.test"],
      match: () => Promise.resolve([]),
      onAgentExecutionFailed: async () => {
        failureHooks += 1;
      },
    };
    const lifecycle = createDaemonDispatchLifecycle({
      database,
      connectionForDaemon: () => undefined,
      providers: [provider],
    });
    const run = (
      await database.createAcceptedTriggerRun({
        organizationId: "org-workflow-terminal",
        projectId: "project-workflow-terminal",
        configurationRevisionId: "revision-workflow-terminal",
        providerEventReceiptId: "receipt-workflow-terminal",
        configuredTriggerName: "terminal",
        prompt: "raw",
        inputs: {},
        triggerContext: { provider: "test" },
        outputContext: { provider: "test" },
        deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
        stepIds: ["step"],
      })
    ).run;
    const step = (await database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await database.insertAgentExecution({
      id: "00000000-0000-4000-8000-0000000000dd",
      organizationId: run.organizationId,
      projectId: run.projectId,
      machineId: null,
      daemonId: DAEMON_ID,
      triggerContext: run.triggerContext,
      outputContext: run.outputContext,
      configurationRevisionId: run.configurationRevisionId,
      workflowStepRunId: step.id,
      deadlineAt: new Date("2000-01-01T00:00:00.000Z"),
      idleDeadlineAt: new Date("2000-01-01T00:00:00.000Z"),
    });
    await database.linkWorkflowStepRunExecution(step.id, execution.id);

    await lifecycle.recoverAgentExecutionDeadlines();

    assert.equal(failureHooks, 0);
    const pendingDelivery = await database.findTriggerRunById(run.id);
    assert.equal(pendingDelivery?.status, "failed");
    assert.equal(pendingDelivery?.outcome, "accepted");
    assert.equal(
      pendingDelivery?.outcome === "accepted"
        ? pendingDelivery.terminalNotificationDeliveredAt
        : null,
      null,
    );

    const engine = createDurableWorkflowHandler({
      database,
      entitlements: createUnlimitedEntitlementsService(),
      providers: [],
      onWorkflowRunTerminal: (terminalRun) => lifecycle.notifyWorkflowRunTerminal(terminalRun),
    }).engine;
    await engine.processAvailable();

    const delivered = await database.findTriggerRunById(run.id);
    assert.equal(failureHooks, 1);
    assert.equal(
      delivered?.outcome === "accepted"
        ? delivered.terminalNotificationDeliveredAt !== null
        : false,
      true,
    );
    await lifecycle.stop();
  });

  it("reports the outputs delivered across workflow steps to the completion hook", async () => {
    const database = createMemoryDatabase();
    const results: unknown[] = [];
    const provider: TriggerProvider = {
      name: "test",
      eventNames: ["manual.test"],
      match: () => Promise.resolve([]),
      onAgentExecutionCompleted: async (_triggerContext, _outputContext, result) => {
        results.push(result);
      },
    };
    const lifecycle = createDaemonDispatchLifecycle({
      database,
      connectionForDaemon: () => undefined,
      providers: [provider],
    });
    const run = (
      await database.createAcceptedTriggerRun({
        organizationId: "org-workflow-emissions",
        projectId: "project-workflow-emissions",
        configurationRevisionId: "revision-workflow-emissions",
        providerEventReceiptId: "receipt-workflow-emissions",
        configuredTriggerName: "emissions",
        prompt: "raw",
        inputs: {},
        triggerContext: { provider: "test" },
        outputContext: { provider: "test" },
        deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
        stepIds: ["first", "second", "skipped"],
      })
    ).run;
    const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
    const emitted: Record<string, string[]> = {
      first: ["linear.reply", "linear.reply"],
      second: ["linear.reply", "github.comment"],
    };
    for (const step of steps) {
      const outputs = emitted[step.stepId];
      if (outputs === undefined) continue;
      const execution = await database.insertAgentExecution({
        id: `00000000-0000-4000-8000-00000000${step.ordinal.toString().padStart(4, "0")}`,
        organizationId: run.organizationId,
        projectId: run.projectId,
        machineId: null,
        daemonId: DAEMON_ID,
        triggerContext: run.triggerContext,
        outputContext: run.outputContext,
        configurationRevisionId: run.configurationRevisionId,
        workflowStepRunId: step.id,
      });
      await database.linkWorkflowStepRunExecution(step.id, execution.id);
      for (const outputType of outputs) {
        const startedAt = new Date("2026-01-01T00:00:00.000Z");
        const attempt = await database.beginAgentExecutionOutput(
          execution.id,
          outputType,
          undefined,
          startedAt,
        );
        assert.ok(attempt);
        await database.completeAgentExecutionOutput(execution.id, attempt.id, startedAt);
      }
    }
    const succeeded = await database.succeedTriggerRun(run.id);
    if (succeeded?.transitioned !== true) throw new Error("expected the run to succeed");

    await lifecycle.notifyWorkflowRunTerminal(succeeded.run);

    assert.deepEqual(results, [
      { status: "succeeded", outputEmissions: { "linear.reply": 3, "github.comment": 1 } },
    ]);
    await lifecycle.stop();
  });

  it("stops only the matching pending executions at a user's request", async () => {
    const database = createMemoryDatabase();
    const connection = new AcknowledgementConnection();
    const lifecycle = createLifecycle(database, connection);
    const run = (
      await database.createAcceptedTriggerRun({
        organizationId: "org-stop",
        projectId: "project-stop",
        configurationRevisionId: "revision-stop",
        providerEventReceiptId: "receipt-stop",
        configuredTriggerName: "agent-session",
        prompt: "raw",
        inputs: {},
        triggerContext: { provider: "test" },
        outputContext: { provider: "linear", agentSessionId: "session-1" },
        deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
        stepIds: ["step"],
      })
    ).run;
    const step = (await database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const stopped = await database.insertAgentExecution({
      id: "00000000-0000-4000-8000-0000000000e1",
      organizationId: run.organizationId,
      projectId: run.projectId,
      machineId: null,
      daemonId: DAEMON_ID,
      triggerContext: run.triggerContext,
      outputContext: run.outputContext,
      configurationRevisionId: run.configurationRevisionId,
      workflowStepRunId: step.id,
    });
    await database.linkWorkflowStepRunExecution(step.id, stopped.id);
    await database.attachAgentToExecution(stopped.id, DAEMON_ID, AGENT_ID);
    await database.transitionAgentExecution(stopped.id, "running");
    const untouched = await database.insertAgentExecution({
      id: "00000000-0000-4000-8000-0000000000e2",
      organizationId: run.organizationId,
      projectId: run.projectId,
      machineId: null,
      daemonId: DAEMON_ID,
      triggerContext: { provider: "test" },
      outputContext: { provider: "linear", agentSessionId: "session-2" },
      configurationRevisionId: run.configurationRevisionId,
    });
    await database.transitionAgentExecution(untouched.id, "running");
    // Accepted for the same session, but its wakeup has not created an execution yet.
    const undispatched = (
      await database.createAcceptedTriggerRun({
        organizationId: "org-stop",
        projectId: "project-stop",
        configurationRevisionId: "revision-stop",
        providerEventReceiptId: "receipt-stop-undispatched",
        configuredTriggerName: "agent-session",
        prompt: "raw",
        inputs: {},
        triggerContext: { provider: "test" },
        outputContext: { provider: "linear", agentSessionId: "session-1" },
        deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
        stepIds: ["step"],
      })
    ).run;
    const otherSessionRun = (
      await database.createAcceptedTriggerRun({
        organizationId: "org-stop",
        projectId: "project-stop",
        configurationRevisionId: "revision-stop",
        providerEventReceiptId: "receipt-stop-other-session",
        configuredTriggerName: "agent-session",
        prompt: "raw",
        inputs: {},
        triggerContext: { provider: "test" },
        outputContext: { provider: "linear", agentSessionId: "session-2" },
        deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
        stepIds: ["step"],
      })
    ).run;

    const result = await lifecycle.stopAgentExecutions({
      projectId: run.projectId,
      reason: "stopped_by_user",
      matches: (execution) => agentSessionIdOf(execution.outputContext) === "session-1",
    });

    assert.deepEqual(
      result.executions.map((execution) => execution.id),
      [stopped.id],
    );
    assert.deepEqual(
      result.runs.map((candidate) => candidate.id),
      [undispatched.id],
    );
    const undispatchedRun = await database.findTriggerRunById(undispatched.id);
    assert.equal(undispatchedRun?.status, "failed");
    assert.equal(undispatchedRun?.failureReason, "stopped_by_user");
    assert.equal(
      (await database.listWorkflowStepRunsForTriggerRun(undispatched.id))[0]?.status,
      "failed",
    );
    assert.equal((await database.findTriggerRunById(otherSessionRun.id))?.status, "running");
    const failed = await database.findAgentExecutionById(stopped.id);
    assert.equal(failed?.status, "failed");
    assert.deepEqual(failed?.result, { status: "failed", reason: "stopped_by_user" });
    assert.equal(failed?.hubAction, "interrupt");
    assert.deepEqual(connection.actions, ["interrupt"]);
    const terminalRun = await database.findTriggerRunById(run.id);
    assert.equal(terminalRun?.status, "failed");
    assert.equal(terminalRun?.failureReason, "stopped_by_user");
    assert.equal((await database.findAgentExecutionById(untouched.id))?.status, "running");

    // A repeated stop finds nothing pending for the session and changes nothing.
    assert.deepEqual(
      await lifecycle.stopAgentExecutions({
        projectId: run.projectId,
        reason: "stopped_by_user",
        matches: (execution) => agentSessionIdOf(execution.outputContext) === "session-1",
      }),
      { executions: [], runs: [] },
    );
    assert.equal((await database.findAgentExecutionById(untouched.id))?.status, "running");
    assert.equal((await database.findTriggerRunById(otherSessionRun.id))?.status, "running");
    await lifecycle.stop();
  });

  it("stops a workflow execution created after the pending-work scan", async () => {
    const database = createMemoryDatabase();
    const connection = new AcknowledgementConnection();
    const lifecycle = createLifecycle(database, connection);
    const run = (
      await database.createAcceptedTriggerRun({
        organizationId: "org-stop-race",
        projectId: "project-stop-race",
        configurationRevisionId: "revision-stop-race",
        providerEventReceiptId: "receipt-stop-race",
        configuredTriggerName: "agent-session",
        prompt: "raw",
        inputs: {},
        triggerContext: { provider: "test" },
        outputContext: { provider: "linear", agentSessionId: "session-race" },
        deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
        stepIds: ["step"],
      })
    ).run;
    const step = (await database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await database.insertAgentExecution({
      id: "00000000-0000-4000-8000-0000000000e3",
      organizationId: run.organizationId,
      projectId: run.projectId,
      machineId: null,
      daemonId: DAEMON_ID,
      triggerContext: run.triggerContext,
      outputContext: run.outputContext,
      configurationRevisionId: run.configurationRevisionId,
      workflowStepRunId: step.id,
    });
    await database.linkWorkflowStepRunExecution(step.id, execution.id);
    await database.attachAgentToExecution(execution.id, DAEMON_ID, AGENT_ID);
    await database.transitionAgentExecution(execution.id, "running");

    // Model the interleaving where creation commits after the first pending scan. The run-level
    // pass must atomically fail the now-linked execution before Stop can be acknowledged.
    vi.spyOn(database, "findPendingAgentExecutions").mockResolvedValueOnce([]);
    const result = await lifecycle.stopAgentExecutions({
      projectId: run.projectId,
      reason: "stopped_by_user",
      matches: (work) => agentSessionIdOf(work.outputContext) === "session-race",
    });

    assert.deepEqual(result.executions, []);
    assert.deepEqual(
      result.runs.map((candidate) => candidate.id),
      [run.id],
    );
    const failed = await database.findAgentExecutionById(execution.id);
    assert.equal(failed?.status, "failed");
    assert.deepEqual(failed?.result, { status: "failed", reason: "stopped_by_user" });
    assert.equal(failed?.hubAction, "interrupt");
    assert.deepEqual(connection.actions, ["interrupt"]);
    await lifecycle.stop();
  });

  it("stops a matching undispatched run behind more than 200 newer project runs", async () => {
    const database = createMemoryDatabase();
    const lifecycle = createLifecycle(database, new AcknowledgementConnection());
    const projectId = "project-busy-stop";
    const createRun = async (index: number, agentSessionId: string) =>
      (
        await database.createAcceptedTriggerRun({
          organizationId: "org-busy-stop",
          projectId,
          configurationRevisionId: "revision-busy-stop",
          providerEventReceiptId: `receipt-busy-stop-${index}`,
          configuredTriggerName: `agent-session-${index}`,
          prompt: "raw",
          inputs: {},
          triggerContext: { provider: "test" },
          outputContext: { provider: "linear", agentSessionId },
          deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
          stepIds: ["step"],
          createdAt: new Date(index),
        })
      ).run;

    const target = await createRun(0, "session-target");
    const newer = await Promise.all(
      Array.from({ length: 201 }, (_, index) => createRun(index + 1, "session-other")),
    );

    const result = await lifecycle.stopAgentExecutions({
      projectId,
      reason: "stopped_by_user",
      matches: (work) => agentSessionIdOf(work.outputContext) === "session-target",
    });

    assert.deepEqual(result.executions, []);
    assert.deepEqual(
      result.runs.map((run) => run.id),
      [target.id],
    );
    assert.equal((await database.findTriggerRunById(target.id))?.status, "failed");
    assert.equal((await database.findTriggerRunById(newer.at(-1)!.id))?.status, "running");
    await lifecycle.stop();
  });

  it("hands a stopped undispatched run to the outbox with the stop reason", async () => {
    const database = createMemoryDatabase();
    const failures: string[] = [];
    const provider: TriggerProvider = {
      name: "test",
      eventNames: ["manual.test"],
      match: () => Promise.resolve([]),
      onAgentExecutionFailed: async (_context, _output, reason) => {
        failures.push(reason);
      },
    };
    const lifecycle = createDaemonDispatchLifecycle({
      database,
      connectionForDaemon: () => undefined,
      providers: [provider],
    });
    const run = (
      await database.createAcceptedTriggerRun({
        organizationId: "org-stop-outbox",
        projectId: "project-stop-outbox",
        configurationRevisionId: "revision-stop-outbox",
        providerEventReceiptId: "receipt-stop-outbox",
        configuredTriggerName: "agent-session",
        prompt: "raw",
        inputs: {},
        triggerContext: { provider: "test" },
        outputContext: { provider: "linear", agentSessionId: "session-1" },
        deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
        stepIds: ["step"],
      })
    ).run;

    const result = await lifecycle.stopAgentExecutions({
      projectId: run.projectId,
      reason: "stopped_by_user",
      matches: (work) => agentSessionIdOf(work.outputContext) === "session-1",
    });

    assert.deepEqual(result.executions, []);
    assert.deepEqual(
      result.runs.map((candidate) => candidate.id),
      [run.id],
    );
    // The provider hears about it through the engine's outbox, like any workflow failure.
    assert.deepEqual(failures, []);
    const engine = createDurableWorkflowHandler({
      database,
      entitlements: createUnlimitedEntitlementsService(),
      providers: [],
      onWorkflowRunTerminal: (terminalRun) => lifecycle.notifyWorkflowRunTerminal(terminalRun),
    }).engine;
    await engine.processAvailable();
    assert.deepEqual(failures, ["stopped_by_user"]);
    const delivered = await database.findTriggerRunById(run.id);
    assert.equal(
      delivered?.outcome === "accepted"
        ? delivered.terminalNotificationDeliveredAt !== null
        : false,
      true,
    );
    // The stopped run never dispatches: its wakeup is gone.
    assert.equal(
      await database.claimWorkflowWakeup(new Date("2099-01-01T00:00:00.000Z"), 1),
      undefined,
    );
    await lifecycle.stop();
  });

  describe("idle deadline after an emitted output", () => {
    const IDLE_TIMEOUT_MS = 10_000;

    /**
     * A real dispatch: the lifecycle registers the completion watcher itself,
     * so the test proves which way the idle deadline settles that watcher.
     * The memory database would complete the step on its own; what is under
     * test here is the lifecycle branch that runs before it.
     */
    async function dispatchedWorkflowExecution(options: {
      emitted: boolean;
      required?: boolean;
      failedDeliveries?: number;
    }) {
      const clock = new ManualDeadlineClock(new Date("2026-01-01T00:00:00.000Z"));
      const database = createMemoryDatabase({ now: () => new Date(clock.now()) });
      const organizationId = "org-idle-output";
      const project = await database.createProject({
        organizationId,
        name: "Idle output",
        slug: "idle-output",
        createdByUserId: null,
      });
      const revision = await database.insertProjectConfigurationRevision({
        projectId: project.id,
        sourceKind: "manual",
        sourceEvidence: { kind: "test" },
        normalizedConfiguration: { environments: [], triggers: [] },
        contentHash: "idle-output",
      });
      await database.issueEnrollmentToken({
        id: "enrollment-idle-output",
        verifier: "enrollment-verifier-idle-output",
        organizationId,
        expiresAt: new Date(clock.now() + 60_000),
        consumedAt: null,
      });
      const daemon = await database.enrollDaemon({
        daemonId: DAEMON_ID,
        idempotencyKey: "enroll-idle-output",
        tokenVerifier: "enrollment-verifier-idle-output",
        serverId: "server-idle-output",
        daemonPublicKey: "public-key",
        credentialVerifier: "verifier",
        permissions: ["hub.execute"],
        now: new Date(clock.now()),
      });
      assert.ok(daemon !== undefined && "machineId" in daemon);
      const { run } = await database.createAcceptedTriggerRun({
        organizationId,
        projectId: project.id,
        configurationRevisionId: revision.id,
        providerEventReceiptId: "receipt-idle-output",
        configuredTriggerName: "idle",
        prompt: "raw",
        inputs: {},
        triggerContext: { provider: "test" },
        outputContext: { provider: "test" },
        deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
        stepIds: ["step"],
      });
      const step = (await database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
      const intent: LaunchMachineIntent = {
        kind: "launch_machine",
        organizationId,
        projectId: project.id,
        triggerRunId: run.id,
        workflowStepRunId: step.id,
        triggerName: "idle",
        environmentName: "work",
        environment: { kind: "daemon", daemonId: DAEMON_ID, authoredSlug: "work", cwd: "/repo" },
        prompt: "reply",
        agent: { provider: "test", mode: "default" },
        allowOutputs: [
          { type: "linear.reply", ...(options.required === true ? { required: true } : {}) },
        ],
        timeoutMs: 60_000,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        autoArchive: false,
        triggerContext: run.triggerContext,
        outputContext: run.outputContext,
        configurationRevisionId: revision.id,
        hubConfig: {},
      };
      const connection = new DispatchConnection();
      const stream = new FailureLogStream();
      // A required output needs a materialized Hub tool for the dispatch to be prepared.
      const executionCapabilities = new OutputExecutorRegistry();
      executionCapabilities.register({
        type: "linear.reply",
        tool: replyOutputTool,
        execute: async () => {},
      });
      const lifecycle = createDaemonDispatchLifecycle({
        database,
        executionCapabilities,
        connectionForDaemon: (daemonId) => (daemonId === DAEMON_ID ? connection : undefined),
        publicBaseUrl: "http://hub.test",
        completionTokenSecret: "completion-secret",
        test: { logger: createLogger(stream), deadlineClock: clock },
      });

      const dispatched = await lifecycle.dispatchLaunchMachineIntent(intent);
      const executionId = dispatched.execution.id;
      assert.equal(connection.subscriptions(), 1, "the dispatch watches its agent");
      if (options.emitted) await emitOutput(database, executionId);
      for (let attempt = 0; attempt < (options.failedDeliveries ?? 0); attempt += 1) {
        await failOutputDelivery(database, executionId);
      }
      await connection.emit({
        type: "agent_update",
        executionId,
        agentId: dispatched.agentId,
        agent: { id: dispatched.agentId, status: "idle" },
        timestamp: new Date(clock.now()).toISOString(),
      });
      assert.equal(
        (await database.findAgentExecutionById(executionId))?.idleDeadlineAt?.getTime(),
        clock.now() + IDLE_TIMEOUT_MS,
      );
      return { clock, connection, database, lifecycle, stream, run, step, executionId };
    }

    it("settles the dispatch as a success when the agent replied but never finished", async () => {
      const fixture = await dispatchedWorkflowExecution({ emitted: true });

      await fixture.clock.advance(IDLE_TIMEOUT_MS);
      await fixture.connection.unsubscribed();

      const execution = await fixture.database.findAgentExecutionById(fixture.executionId);
      assert.deepEqual(
        { status: execution?.status, result: execution?.result },
        { status: "succeeded", result: { status: "succeeded" } },
      );
      assert.equal(execution?.completedByAgentAt, null);
      assert.equal(
        (await fixture.database.findWorkflowStepRunById(fixture.step.id))?.status,
        "succeeded",
      );
      assert.equal((await fixture.database.findTriggerRunById(fixture.run.id))?.status, "running");
      assert.deepEqual(
        dispatchFailures(fixture.stream),
        [],
        "the completion watcher resolved without a DaemonDispatchFailure",
      );
      await fixture.lifecycle.stop();
    });

    it("returns success when finish_execution arrives after the idle timestamp", async () => {
      const fixture = await dispatchedWorkflowExecution({ emitted: true });
      fixture.clock.elapseWithoutRunningTimers(IDLE_TIMEOUT_MS);

      const execution = await fixture.lifecycle.completeAgentExecutionFromCallback({
        executionId: fixture.executionId,
        token: deriveAgentExecutionCompletionToken("completion-secret", fixture.executionId),
      });

      assert.equal(execution.status, "succeeded");
      assert.equal(execution.completedByAgentAt, null);
      assert.equal(
        (await fixture.database.findWorkflowStepRunById(fixture.step.id))?.status,
        "succeeded",
      );
      await fixture.connection.unsubscribed();
      await fixture.lifecycle.stop();
    });

    it("still settles the dispatch as an idle timeout when the agent never replied", async () => {
      const fixture = await dispatchedWorkflowExecution({ emitted: false });

      await fixture.clock.advance(IDLE_TIMEOUT_MS);
      await fixture.connection.unsubscribed();

      const execution = await fixture.database.findAgentExecutionById(fixture.executionId);
      assert.deepEqual(
        { status: execution?.status, result: execution?.result },
        { status: "failed", result: { status: "failed", reason: "step_idle_timeout" } },
      );
      assert.equal(
        (await fixture.database.findWorkflowStepRunById(fixture.step.id))?.status,
        "timed_out",
      );
      assert.deepEqual(dispatchFailures(fixture.stream), ["step_idle_timeout"]);
      await fixture.lifecycle.stop();
    });

    it("completes a standalone execution whose agent replied but never finished", async () => {
      const database = createMemoryDatabase();
      const lifecycle = createDaemonDispatchLifecycle({
        database,
        connectionForDaemon: () => undefined,
      });
      const execution = await database.insertAgentExecution({
        id: "00000000-0000-4000-8000-0000000000ef",
        organizationId: "org-idle-output",
        projectId: "project-idle-output",
        machineId: null,
        daemonId: DAEMON_ID,
        triggerContext: {},
        outputContext: {},
        configurationRevisionId: "revision-idle-output",
        deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
        idleDeadlineAt: new Date("2000-01-01T00:00:00.000Z"),
      });
      await emitOutput(database, execution.id);

      await lifecycle.recoverAgentExecutionDeadlines();

      const current = await database.findAgentExecutionById(execution.id);
      assert.deepEqual(
        { status: current?.status, result: current?.result },
        { status: "succeeded", result: { status: "succeeded" } },
      );
      await lifecycle.stop();
    });

    it("still settles the dispatch as an idle timeout when every required delivery failed", async () => {
      const fixture = await dispatchedWorkflowExecution({
        emitted: false,
        required: true,
        failedDeliveries: 3,
      });

      await fixture.clock.advance(IDLE_TIMEOUT_MS);
      await fixture.connection.unsubscribed();

      const execution = await fixture.database.findAgentExecutionById(fixture.executionId);
      assert.deepEqual(
        { status: execution?.status, result: execution?.result },
        { status: "failed", result: { status: "failed", reason: "step_idle_timeout" } },
      );
      assert.deepEqual(dispatchFailures(fixture.stream), ["step_idle_timeout"]);
      await fixture.lifecycle.stop();
    });

    it("ends the run as failed when finish_execution follows only failed required deliveries", async () => {
      const fixture = await dispatchedWorkflowExecution({
        emitted: false,
        required: true,
        failedDeliveries: 3,
      });

      await assert.rejects(
        fixture.lifecycle.completeAgentExecutionFromCallback({
          executionId: fixture.executionId,
          token: deriveAgentExecutionCompletionToken("completion-secret", fixture.executionId),
        }),
        isOutputDeliveryFailedCompletionFailure,
      );
      await fixture.connection.unsubscribed();

      const execution = await fixture.database.findAgentExecutionById(fixture.executionId);
      assert.deepEqual(
        { status: execution?.status, result: execution?.result },
        { status: "failed", result: { status: "failed", reason: "output_delivery_failed" } },
      );
      const step = await fixture.database.findWorkflowStepRunById(fixture.step.id);
      assert.deepEqual(
        { status: step?.status, failureReason: step?.failureReason },
        { status: "failed", failureReason: "output_delivery_failed" },
      );
      const run = await fixture.database.findTriggerRunById(fixture.run.id);
      if (run?.outcome !== "accepted") throw new Error("accepted run was not persisted");
      assert.deepEqual(
        { status: run.status, failureReason: run.failureReason },
        { status: "failed", failureReason: "output_delivery_failed" },
      );
      assert.deepEqual(dispatchFailures(fixture.stream), ["output_delivery_failed"]);
      const logged = fixture.stream.records().find(isOutputDeliveryLogRecord);
      assert.deepEqual(
        logged?.["diagnostic"],
        {
          executionId: fixture.executionId,
          outputs: [{ type: "linear.reply", failedAttempts: 3 }],
        },
        "the log line carries the attempt count",
      );
      await fixture.lifecycle.stop();
    });
  });

  it("ignores unrelated failed or canceled tools when finish_execution completes", async () => {
    const fixture = await acknowledgementFixture();
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);

    await fixture.connection.emit(toolCall("shell-call", "shell", "failed"));
    await fixture.connection.emit(toolCall("other-call", "other", "canceled"));
    await fixture.connection.emit(
      toolCall("finish-call", "mcp__hub__finish_execution", "completed"),
    );
    await fixture.connection.emit(
      toolCall("finish-call-retry", "hub.finish_execution", "canceled"),
    );
    await fixture.connection.emit(turnCompleted());
    await fixture.connection.emit(agentIdle());

    const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
    assert.equal(execution?.hubActionAcknowledgements.finishExecutionCall?.callId, "finish-call");
    assert.equal(execution?.hubActionAcknowledgements.finishExecutionCall?.status, "completed");
    assert.deepEqual(fixture.connection.actions, ["archive"]);
    assert.notEqual(execution?.hubActionReadyAt, null);
    assert.notEqual(execution?.hubActionCompletedAt, null);
    await fixture.lifecycle.stop();
  });

  it.each(["running", "canceled"] as const)(
    "does not archive while finish_execution is %s",
    async (status) => {
      const fixture = await acknowledgementFixture();
      await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);

      await fixture.connection.emit(toolCall("finish-call", "hub.finish_execution", status));
      await fixture.connection.emit(turnCompleted());
      await fixture.connection.emit(agentIdle());

      const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
      assert.deepEqual(fixture.connection.actions, []);
      assert.equal(execution?.hubActionReadyAt, null);
      assert.equal(execution?.hubActionCompletedAt, null);
      await fixture.lifecycle.stop();
    },
  );

  it("resumes durable partial signals across restart and archives exactly once", async () => {
    const fixture = await acknowledgementFixture();
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    await fixture.connection.emit(toolCall("finish-call", "hub.finish_execution", "completed"));
    await fixture.lifecycle.stop();

    fixture.lifecycle = createLifecycle(fixture.database, fixture.connection);
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    assert.equal(
      (await fixture.database.findAgentExecutionById(EXECUTION_ID))?.hubActionReadyAt,
      null,
    );
    await fixture.connection.emit(turnCompleted());
    await fixture.lifecycle.stop();

    fixture.lifecycle = createLifecycle(fixture.database, fixture.connection);
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    assert.notEqual(
      (await fixture.database.findAgentExecutionById(EXECUTION_ID))?.hubActionAcknowledgements
        .terminalAt,
      null,
    );
    await fixture.connection.emit(agentIdle());

    fixture.lifecycle = createLifecycle(fixture.database, fixture.connection);
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
    assert.deepEqual(fixture.connection.actions, ["archive"]);
    assert.notEqual(execution?.hubActionReadyAt, null);
    assert.notEqual(execution?.hubActionCompletedAt, null);
    await fixture.lifecycle.stop();
  });
});

function agentSessionIdOf(outputContext: unknown): unknown {
  return typeof outputContext === "object" &&
    outputContext !== null &&
    "agentSessionId" in outputContext
    ? outputContext.agentSessionId
    : undefined;
}

async function acknowledgementFixture() {
  const database = createMemoryDatabase({ now: () => new Date("2026-01-01T00:00:00.000Z") });
  await database.insertAgentExecution({
    id: EXECUTION_ID,
    organizationId: "org-ack-test",
    projectId: "project-ack-test",
    machineId: null,
    daemonId: DAEMON_ID,
    triggerContext: {},
    outputContext: {},
    configurationRevisionId: "revision-ack-test",
  });
  await database.attachAgentToExecution(EXECUTION_ID, DAEMON_ID, AGENT_ID);
  await database.transitionAgentExecution(EXECUTION_ID, "succeeded", {
    completedByAgent: true,
    hubAction: "archive",
  });
  const connection = new AcknowledgementConnection();
  return {
    database,
    connection,
    lifecycle: createLifecycle(database, connection),
  };
}

async function emitOutput(
  database: Awaited<ReturnType<typeof createMemoryDatabase>>,
  executionId: string,
): Promise<void> {
  const startedAt = new Date("2000-01-01T00:00:00.000Z");
  const attempt = await database.beginAgentExecutionOutput(
    executionId,
    "linear.reply",
    undefined,
    startedAt,
  );
  assert.ok(attempt !== undefined);
  const updated = await database.completeAgentExecutionOutput(executionId, attempt.id, startedAt);
  assert.equal(updated?.outputEmissions["linear.reply"], 1);
}

/** A delivery the provider refused: an attempt exists, but nothing was emitted. */
async function failOutputDelivery(
  database: Awaited<ReturnType<typeof createMemoryDatabase>>,
  executionId: string,
): Promise<void> {
  const startedAt = new Date("2000-01-01T00:00:00.000Z");
  const attempt = await database.beginAgentExecutionOutput(
    executionId,
    "linear.reply",
    undefined,
    startedAt,
  );
  assert.ok(attempt !== undefined);
  assert.equal(await database.failAgentExecutionOutput(executionId, attempt.id, startedAt), true);
  assert.equal(
    (await database.findAgentExecutionById(executionId))?.outputEmissions["linear.reply"],
    undefined,
  );
}

/** Whether a completion rejection is the one raised for undelivered required outputs. */
function isOutputDeliveryFailedCompletionFailure(error: unknown): boolean {
  return (
    error instanceof AgentExecutionCompletionFailure && error.reason === "output_delivery_failed"
  );
}

/** Whether a log record is the daemon's output-delivery diagnostic. */
function isOutputDeliveryLogRecord(record: Record<string, unknown>): boolean {
  return record["operation"] === "daemon.execution.output-delivery";
}

/** Dispatch failures the lifecycle reported after the completion watcher rejected. */
function dispatchFailures(stream: FailureLogStream): string[] {
  return stream
    .records()
    .filter((record) => record["operation"] === "daemon.dispatch")
    .map((record) => {
      const error = record["err"];
      const code: unknown =
        typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
      return typeof code === "string" ? code : "unknown";
    });
}

class ManualDeadlineClock implements ExecutionDeadlineClock {
  private nowMs: number;
  private readonly timers = new Map<number, { at: number; callback: () => Promise<void> }>();
  private nextTimerId = 1;

  constructor(start: Date) {
    this.nowMs = start.getTime();
  }

  now(): number {
    return this.nowMs;
  }

  schedule(callback: () => Promise<void>, delayMs: number): () => void {
    const id = this.nextTimerId++;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return () => {
      this.timers.delete(id);
    };
  }

  /** Advances wall time while retaining due callbacks, reproducing a callback/idle-timer race. */
  elapseWithoutRunningTimers(ms: number): void {
    this.nowMs += ms;
  }

  /** Moves time forward and runs every deadline that became due, in order. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const due = Array.from(this.timers.entries())
        .filter(([, timer]) => timer.at <= target)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.nowMs = Math.max(this.nowMs, timer.at);
      await timer.callback();
    }
    this.nowMs = target;
  }
}

class DispatchConnection implements DaemonConnection {
  private readonly handlers = new Set<DaemonEventHandler>();

  on(handler: DaemonEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscriptions(): number {
    return this.handlers.size;
  }

  /** Resolves once the dispatch released its event subscription, which only happens after its completion watcher settled. */
  async unsubscribed(): Promise<void> {
    for (let attempt = 0; attempt < 50 && this.handlers.size > 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(this.handlers.size, 0, "the dispatch never settled");
  }

  async emit(event: DaemonEvent): Promise<void> {
    for (const handler of this.handlers) await handler(event);
  }

  async createAgent(): Promise<{ id: string }> {
    return { id: AGENT_ID };
  }

  async controlExecution(): Promise<void> {}
}

function createLifecycle(
  database: Awaited<ReturnType<typeof createMemoryDatabase>>,
  connection: AcknowledgementConnection,
): DaemonDispatchLifecycle {
  return createDaemonDispatchLifecycle({
    database,
    connectionForDaemon: (daemonId) => (daemonId === DAEMON_ID ? connection : undefined),
  });
}

class AcknowledgementConnection implements DaemonConnection {
  readonly actions: DaemonExecutionControlOptions["action"][] = [];
  private readonly handlers = new Set<DaemonEventHandler>();

  on(handler: DaemonEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async emit(event: DaemonEvent): Promise<void> {
    for (const handler of this.handlers) await handler(event);
  }

  async emitObserved(event: DaemonEvent): Promise<void> {
    for (const handler of this.handlers) {
      await Promise.resolve(handler(event)).catch(() => undefined);
    }
  }

  async createAgent(): Promise<never> {
    throw new Error("not used");
  }

  async getProviderSnapshot(): Promise<never> {
    throw new Error("not used");
  }

  async refreshProviderSnapshot(): Promise<never> {
    throw new Error("not used");
  }

  async controlExecution(options: DaemonExecutionControlOptions): Promise<void> {
    this.actions.push(options.action);
  }
}

function toolCall(
  callId: string,
  name: string,
  status: "running" | "completed" | "failed" | "canceled",
): DaemonEvent {
  return {
    type: "agent_stream",
    executionId: EXECUTION_ID,
    agentId: AGENT_ID,
    timestamp: ACKNOWLEDGED_AT.toISOString(),
    event: {
      type: "timeline",
      provider: "test",
      item: { type: "tool_call", callId, name, status },
    },
  } as DaemonEvent;
}

function daemonRecord(): DaemonRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: DAEMON_ID,
    slug: "daemon-lifecycle",
    machineId: "machine-lifecycle",
    serverId: "server-lifecycle",
    daemonPublicKey: "public-key",
    credentialVerifier: "verifier",
    permissions: ["hub.execute"],
    registeredByApiKeyId: null,
    registeredByCliCredentialId: null,
    status: "active",
    presence: "connected",
    connectedAt: now,
    disconnectedAt: null,
    lastSeenAt: now,
    createdAt: now,
  };
}

function turnCompleted(): DaemonEvent {
  return {
    type: "agent_stream",
    executionId: EXECUTION_ID,
    agentId: AGENT_ID,
    timestamp: ACKNOWLEDGED_AT.toISOString(),
    event: { type: "turn_completed", provider: "test" },
  };
}

function agentIdle(): DaemonEvent {
  return {
    type: "agent_update",
    executionId: EXECUTION_ID,
    agentId: AGENT_ID,
    timestamp: ACKNOWLEDGED_AT.toISOString(),
    agent: { id: AGENT_ID, status: "idle" },
  };
}
