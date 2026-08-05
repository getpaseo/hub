import { randomUUID } from "node:crypto";
import { DatabaseUnavailableError } from "../db/errors.js";
import type { AgentExecutionRecord, Database, DurableTrigger } from "../db/types.js";
import type { AgentExecutionStatus } from "../db/schema.js";
import { logger as defaultLogger } from "../logger.js";
import { durableExecutionId } from "../daemons/lifecycle.js";
import {
  buildLaunchMachineIntent,
  type LaunchMachineIntent,
} from "../dispatcher/launch-machine-intent.js";
import type {
  TriggerDispatchOutcome,
  TriggerEventName,
  TriggerHandler,
  TriggerProvider,
  TriggerProviderMatch,
} from "../triggers/index.js";
import { interpolateInvocation } from "../triggers/invocation.js";

const DEFAULT_WAKEUP_LEASE_MS = 30_000;
const DEFAULT_WORKER_INTERVAL_MS = 250;

export interface DurableWorkflowEngineOptions {
  database: Database | null;
  providers?: readonly TriggerProvider[];
  dispatchLaunchMachineIntent?: (intent: LaunchMachineIntent) => Promise<unknown>;
  configurationRevisionId?: string;
  leaseMs?: number;
  workerIntervalMs?: number;
  now?: () => Date;
}

export class DurableWorkflowEngine {
  private readonly logger = defaultLogger;
  private readonly leaseMs: number;
  private readonly workerIntervalMs: number;
  private readonly now: () => Date;
  private workerTimer: NodeJS.Timeout | undefined;
  private processing: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly options: DurableWorkflowEngineOptions) {
    this.leaseMs = options.leaseMs ?? DEFAULT_WAKEUP_LEASE_MS;
    this.workerIntervalMs = options.workerIntervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    this.stopped = false;
    if (this.workerTimer !== undefined) return;
    this.workerTimer = setInterval(() => {
      void this.processAvailable();
    }, this.workerIntervalMs);
    this.workerTimer.unref();
    void this.processAvailable();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.workerTimer !== undefined) clearInterval(this.workerTimer);
    this.workerTimer = undefined;
    await this.processing;
  }

  async enqueue(trigger: DurableTrigger): Promise<TriggerDispatchOutcome> {
    if (this.options.database === null) throw new DatabaseUnavailableError();
    const matches = await collectProviderMatches(this.options.providers ?? [], trigger);
    if (matches.length === 0) {
      await this.options.database.markTriggerDropped(trigger.triggerId, "no_matching_trigger");
      this.logger.info(
        { source: trigger.source, deliveryId: trigger.deliveryId, triggerId: trigger.triggerId },
        "skipping trigger with no matching configured trigger",
      );
      return { triggerId: trigger.triggerId };
    }
    const createdAt = this.now();
    await Promise.all(
      matches.map(async (match) => {
        if (match.invocation.status === "rejected") {
          await this.options.database!.markTriggerDropped(
            trigger.triggerId,
            `rejected_input:${match.triggerName}:${match.invocation.reason}`,
          );
          return;
        }
        const configurationRevisionId =
          match.configurationRevisionId ?? this.options.configurationRevisionId;
        if (configurationRevisionId === undefined) {
          throw new Error("workflow_configuration_revision_required");
        }
        if (match.stepId === undefined) {
          throw new Error("workflow_step_id_required");
        }
        if (match.runTimeoutMs === undefined) {
          throw new Error("workflow_run_max_runtime_required");
        }

        const stepRunId = randomUUID();
        const runDeadline = new Date(createdAt.getTime() + match.runTimeoutMs);
        const materializedMatch = {
          ...match,
          prompt: interpolateInvocation(match.prompt, match.invocation),
          agent: {
            ...match.agent,
            provider: interpolateInvocation(match.agent.provider, match.invocation),
            ...(match.agent.model === undefined
              ? {}
              : { model: interpolateInvocation(match.agent.model, match.invocation) }),
            mode: interpolateInvocation(match.agent.mode, match.invocation),
            ...(match.agent.thinkingOptionId === undefined
              ? {}
              : {
                  thinkingOptionId: interpolateInvocation(
                    match.agent.thinkingOptionId,
                    match.invocation,
                  ),
                }),
          },
        } satisfies TriggerProviderMatch;
        const baseIntent = buildLaunchMachineIntent({
          ...materializedMatch,
          organizationId: trigger.organizationId,
          projectId: trigger.projectId,
          triggerId: trigger.triggerId,
          configurationRevisionId,
        });
        const intent: LaunchMachineIntent = {
          ...baseIntent,
          workflowStepRunId: stepRunId,
        };
        await this.options.database!.createTriggerRun({
          organizationId: trigger.organizationId,
          projectId: trigger.projectId,
          configurationRevisionId,
          triggerId: trigger.triggerId,
          configuredTriggerName: match.triggerName,
          rawPrompt: match.invocation.rawMessage,
          prompt: match.invocation.prompt,
          inputs: match.invocation.inputs,
          deadlineAt: runDeadline,
          stepId: match.stepId,
          stepRunId,
          dispatchIntent: intent,
          createdAt,
        });
      }),
    );

    return { triggerId: trigger.triggerId };
  }

  async processAvailable(): Promise<void> {
    if (this.options.database === null || this.stopped) return;
    if (this.processing !== undefined) return this.processing;
    this.processing = this.processAvailableImpl().finally(() => {
      this.processing = undefined;
    });
    return this.processing;
  }

  private async processAvailableImpl(): Promise<void> {
    const database = this.options.database;
    if (database === null) return;
    const now = this.now();
    await database.recoverWorkflowWakeups(now);
    while (!this.stopped) {
      const wakeup = await database.claimWorkflowWakeup(this.now(), this.leaseMs);
      if (wakeup === undefined) return;
      try {
        await this.processWakeup(wakeup.triggerRunId);
      } catch (error) {
        this.logger.error(
          { err: error, triggerRunId: wakeup.triggerRunId },
          "durable workflow wakeup processing failed",
        );
      }
    }
  }

  private async processWakeup(triggerRunId: string): Promise<void> {
    const database = this.options.database;
    if (database === null) return;
    const run = await database.findTriggerRunById(triggerRunId);
    if (run === undefined || run.status !== "running") {
      await database.deleteWorkflowWakeup(triggerRunId);
      return;
    }
    const step = await database.findWorkflowStepRunByTriggerRun(run.id);
    if (step === undefined) throw new Error(`workflow step run missing for ${run.id}`);

    if (step.agentExecutionId !== null) {
      const execution = await database.findAgentExecutionById(step.agentExecutionId);
      if (execution === undefined) throw new Error(`workflow execution missing for ${step.id}`);
      if (execution.status === "succeeded" || execution.status === "failed") {
        await database.completeWorkflowStep(
          execution.id,
          execution.status,
          execution.result,
          execution.status === "failed" ? readFailureReason(execution.result) : undefined,
        );
      }
      await database.deleteWorkflowWakeup(run.id);
      return;
    }

    const now = this.now();
    if (now >= run.deadlineAt) {
      await database.failWorkflowRun(run.id, "timed_out", "workflow_run_deadline_exceeded");
      return;
    }
    const persistedIntent = step.dispatchIntent;
    if (persistedIntent === null)
      throw new Error(`workflow dispatch intent missing for ${step.id}`);
    const stepDeadline =
      persistedIntent.timeoutMs === undefined
        ? run.deadlineAt
        : new Date(now.getTime() + persistedIntent.timeoutMs);
    const deadlineAt = new Date(Math.min(run.deadlineAt.getTime(), stepDeadline.getTime()));
    const timeoutMs = Math.max(0, deadlineAt.getTime() - now.getTime());
    const intent: LaunchMachineIntent = {
      ...persistedIntent,
      workflowStepRunId: step.id,
      deadlineAt,
      timeoutMs,
    };
    const result = await this.dispatch(intent);
    const execution = await this.executionFromResult(result, intent, step.id);
    await database.linkWorkflowStepRunExecution(step.id, execution.id);
    if (execution.status === "succeeded" || execution.status === "failed") {
      await database.completeWorkflowStep(
        execution.id,
        execution.status,
        execution.result,
        execution.status === "failed" ? readFailureReason(execution.result) : undefined,
      );
    }
    await database.deleteWorkflowWakeup(run.id);
  }

  private async dispatch(intent: LaunchMachineIntent): Promise<unknown> {
    if (this.options.dispatchLaunchMachineIntent !== undefined) {
      return this.options.dispatchLaunchMachineIntent(intent);
    }
    throw new Error("no durable workflow dispatch handler registered");
  }

  private async executionFromResult(
    result: unknown,
    intent: LaunchMachineIntent,
    stepRunId: string,
  ) {
    const candidate = readDispatchExecution(result);
    if (candidate !== undefined) return candidate;
    const database = this.options.database;
    if (database !== null) {
      const existing = await database.findAgentExecutionByWorkflowStepRunId(stepRunId);
      if (existing !== undefined) return existing;
    }
    throw new Error(`durable dispatch returned no execution: ${durableExecutionId(intent)}`);
  }
}

export function createDurableWorkflowHandler(options: DurableWorkflowEngineOptions): {
  handler: TriggerHandler;
  engine: DurableWorkflowEngine;
} {
  const engine = new DurableWorkflowEngine(options);
  return { handler: (trigger) => engine.enqueue(trigger), engine };
}

async function collectProviderMatches(
  providers: readonly TriggerProvider[],
  trigger: DurableTrigger,
): Promise<readonly TriggerProviderMatch[]> {
  const source = trigger.source;
  if (!isTriggerEventName(source)) return [];
  const matchingProviders = providers.filter((provider) => provider.eventNames.includes(source));
  const nestedMatches = await Promise.all(
    matchingProviders.map((provider) => provider.match(trigger)),
  );
  return nestedMatches.flat();
}

function readDispatchExecution(
  result: unknown,
): Pick<AgentExecutionRecord, "id" | "status" | "result"> | undefined {
  if (!isRecord(result)) return undefined;
  const direct = readExecutionCandidate(result["execution"]);
  if (direct !== undefined) return direct;
  const executions = result["executions"];
  if (!Array.isArray(executions)) return undefined;
  return readExecutionCandidate(executions[0]);
}

function readExecutionCandidate(
  value: unknown,
): Pick<AgentExecutionRecord, "id" | "status" | "result"> | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") return undefined;
  return {
    id: value["id"],
    status: readExecutionStatus(value["status"]),
    result: value["result"],
  };
}

function readExecutionStatus(value: unknown): AgentExecutionStatus {
  return value === "running" || value === "succeeded" || value === "failed" ? value : "spawning";
}

function readFailureReason(result: unknown): string | undefined {
  return isRecord(result) && typeof result["reason"] === "string" ? result["reason"] : undefined;
}

function isTriggerEventName(value: string): value is TriggerEventName {
  return /^[^.]+\.[^.]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
