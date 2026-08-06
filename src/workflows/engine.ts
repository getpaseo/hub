import { DatabaseUnavailableError } from "../db/errors.js";
import type {
  AgentExecutionRecord,
  Database,
  DurableTrigger,
  WorkflowDeadlineRecovery,
} from "../db/types.js";
import type { AgentExecutionStatus } from "../db/schema.js";
import { parseCompiledHubConfig, type JsonPrimitive } from "../config/compiler.js";
import type { CompiledProjectConfiguration } from "../configuration/store.js";
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
  AcceptedTriggerProviderMatch,
} from "../triggers/index.js";
import { isAcceptedTriggerProviderMatch } from "../triggers/index.js";
import {
  evaluateExpression,
  renderExpressionTemplate,
  type ExpressionContext,
} from "./expression.js";

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
  onWorkflowDeadlineExceeded?: (recovery: WorkflowDeadlineRecovery) => Promise<void>;
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
    this.workerTimer = setInterval(() => void this.processAvailable(), this.workerIntervalMs);
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
      return { triggerId: trigger.triggerId };
    }
    const createdAt = this.now();
    await Promise.all(
      matches.map(async (match) => {
        const configurationRevisionId =
          match.configurationRevisionId ?? this.options.configurationRevisionId;
        if (configurationRevisionId === undefined)
          throw new Error("workflow_configuration_revision_required");
        if (match.invocation.status === "rejected") {
          await this.options.database!.createRejectedTriggerRun({
            organizationId: trigger.organizationId,
            projectId: trigger.projectId,
            configurationRevisionId,
            triggerId: trigger.triggerId,
            configuredTriggerName: match.triggerName,
            rawPrompt: match.invocation.rawMessage,
            prompt: match.invocation.prompt,
            inputs: match.invocation.inputs,
            triggerContext: match.triggerContext,
            outputContext: match.outputContext,
            rejection: match.invocation.rejection,
            createdAt,
          });
          return;
        }
        if (!isAcceptedTriggerProviderMatch(match))
          throw new Error("accepted workflow match required");
        const acceptedMatch: AcceptedTriggerProviderMatch = match;
        const configuration = asProjectConfiguration(
          parseCompiledHubConfig(acceptedMatch.hubConfig),
        );
        const compiledTrigger = configuration.triggers.find(
          (candidate) => candidate.name === acceptedMatch.triggerName,
        );
        if (compiledTrigger === undefined)
          throw new Error(`compiled trigger not found: ${acceptedMatch.triggerName}`);
        const runDeadline = new Date(createdAt.getTime() + compiledTrigger.maxRuntimeMs);
        await this.options.database!.createAcceptedTriggerRun({
          organizationId: trigger.organizationId,
          projectId: trigger.projectId,
          configurationRevisionId,
          triggerId: trigger.triggerId,
          configuredTriggerName: acceptedMatch.triggerName,
          rawPrompt: acceptedMatch.invocation.rawMessage,
          prompt: acceptedMatch.invocation.prompt,
          inputs: acceptedMatch.invocation.inputs,
          triggerContext: acceptedMatch.triggerContext,
          outputContext: acceptedMatch.outputContext,
          deadlineAt: runDeadline,
          stepIds: compiledTrigger.steps.map((step) => step.id),
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
    await this.recoverWorkflowDeadlines(this.now());
    await database.recoverWorkflowWakeups(this.now());
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
    if (run === undefined || run.status !== "running" || run.outcome !== "accepted") {
      await database.deleteWorkflowWakeup(triggerRunId);
      return;
    }
    if (run.deadlineAt <= this.now()) {
      await this.recoverWorkflowDeadlines(this.now());
      await database.deleteWorkflowWakeup(triggerRunId);
      return;
    }
    const configuration = await this.configurationForRun(
      run.projectId,
      run.configurationRevisionId,
    );
    const trigger = configuration.triggers.find(
      (candidate) => candidate.name === run.configuredTriggerName,
    );
    if (trigger === undefined)
      throw new Error(`workflow trigger not found: ${run.configuredTriggerName}`);
    let steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
    if (steps.length !== trigger.steps.length)
      throw new Error(`workflow steps missing for ${run.id}`);

    await this.reconcileTerminalStepExecutions(steps);
    const reconciledRun = await database.findTriggerRunById(run.id);
    if (reconciledRun === undefined || reconciledRun.status !== "running") {
      await database.deleteWorkflowWakeup(run.id);
      return;
    }
    steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
    const liveExecution = await this.findLiveExecution(steps);
    if (liveExecution !== undefined) {
      await database.deleteWorkflowWakeup(run.id);
      return;
    }
    const next = steps.find((step) => step.status === "pending");
    if (next === undefined) {
      await database.succeedTriggerRun(run.id);
      return;
    }
    const step = trigger.steps[next.ordinal];
    if (step === undefined) throw new Error(`compiled step missing for ${next.stepId}`);
    const context = workflowContext(reconciledRun, steps, trigger.values);
    let shouldRun = true;
    try {
      shouldRun =
        step.condition === undefined || truthy(evaluateExpression(step.condition, context));
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "workflow_condition_evaluation_failed";
      await database.failWorkflowRun(run.id, "failed", reason, step.id);
      return;
    }
    if (!shouldRun) {
      await database.markWorkflowStepSkipped(run.id, step.id, "condition_false");
      return;
    }
    const startedAt = this.now();
    const deadlineAt = new Date(
      Math.min(run.deadlineAt.getTime(), startedAt.getTime() + step.maxRuntimeMs),
    );
    const idleDeadlineAt = new Date(
      Math.min(
        run.deadlineAt.getTime(),
        deadlineAt.getTime(),
        startedAt.getTime() + step.idleTimeoutMs,
      ),
    );
    const intent = buildStepIntent(
      configuration,
      trigger,
      step,
      reconciledRun,
      context,
      next.id,
      deadlineAt,
    );
    const executionId = durableExecutionId(intent);
    const created = await database.createWorkflowStepExecution({
      triggerRunId: run.id,
      stepId: step.id,
      ordinal: next.ordinal,
      executionId,
      execution: {
        id: executionId,
        organizationId: run.organizationId,
        projectId: run.projectId,
        machineId: null,
        daemonId: null,
        triggerId: run.triggerId,
        triggerContext: run.triggerContext,
        outputContext: run.outputContext,
        configurationRevisionId: run.configurationRevisionId,
        deadlineAt,
        idleDeadlineAt,
        startedAt,
        workflowStepRunId: next.id,
        launchIntent: intent,
      },
    });
    if (created.execution === undefined) {
      await database.deleteWorkflowWakeup(run.id);
      return;
    }
    await database.linkWorkflowStepRunExecution(next.id, created.execution.id, intent);
    if (!created.created) {
      await this.finishPersistedExecution(created.execution);
      await database.deleteWorkflowWakeup(run.id);
      return;
    }
    const result = await this.dispatch(intent);
    const execution = await this.executionFromResult(result, intent, next.id);
    if (execution.id !== created.execution.id) {
      throw new Error(`durable dispatch returned a different execution: ${execution.id}`);
    }
    await this.finishPersistedExecution(execution);
    await database.deleteWorkflowWakeup(run.id);
  }

  private async recoverWorkflowDeadlines(now: Date): Promise<void> {
    const database = this.options.database;
    if (database === null) return;
    for (const recovery of await database.recoverWorkflowDeadlines(now)) {
      if (this.options.onWorkflowDeadlineExceeded === undefined) continue;
      await this.options.onWorkflowDeadlineExceeded(recovery);
    }
  }

  private async finishPersistedExecution(
    execution: Pick<AgentExecutionRecord, "id" | "status" | "result">,
  ): Promise<void> {
    if (execution.status !== "succeeded" && execution.status !== "failed") return;
    const database = this.options.database;
    if (database === null) return;
    await database.completeWorkflowStep(
      execution.id,
      execution.status,
      execution.result,
      execution.status === "failed" ? readFailureReason(execution.result) : undefined,
    );
  }

  private async findLiveExecution(
    steps: readonly { status: string; agentExecutionId: string | null }[],
  ): Promise<AgentExecutionRecord | undefined> {
    const database = this.options.database;
    if (database === null) return undefined;
    for (const step of steps) {
      if (step.status !== "running" || step.agentExecutionId === null) continue;
      const execution = await database.findAgentExecutionById(step.agentExecutionId);
      if (
        execution !== undefined &&
        (execution.status === "spawning" || execution.status === "running")
      )
        return execution;
    }
    return undefined;
  }

  private async reconcileTerminalStepExecutions(
    steps: readonly { status: string; agentExecutionId: string | null }[],
  ): Promise<void> {
    const database = this.options.database;
    if (database === null) return;
    for (const step of steps) {
      if (step.status !== "running" || step.agentExecutionId === null) continue;
      const execution = await database.findAgentExecutionById(step.agentExecutionId);
      if (
        execution === undefined ||
        (execution.status !== "succeeded" && execution.status !== "failed")
      ) {
        continue;
      }
      await database.completeWorkflowStep(
        execution.id,
        execution.status === "succeeded" ? "succeeded" : "failed",
        execution.result,
        readFailureReason(execution.result),
      );
    }
  }

  private async configurationForRun(
    projectId: string,
    revisionId: string,
  ): Promise<CompiledProjectConfiguration> {
    const database = this.options.database;
    if (database === null) throw new DatabaseUnavailableError();
    const revision = await database.findProjectConfigurationRevision(projectId, revisionId);
    if (revision === undefined)
      throw new Error(`workflow configuration revision not found: ${revisionId}`);
    return asProjectConfiguration(parseCompiledHubConfig(revision.normalizedConfiguration));
  }

  private async dispatch(intent: LaunchMachineIntent): Promise<unknown> {
    if (this.options.dispatchLaunchMachineIntent !== undefined)
      return this.options.dispatchLaunchMachineIntent(intent);
    throw new Error("no durable workflow dispatch handler registered");
  }

  private async executionFromResult(
    result: unknown,
    intent: LaunchMachineIntent,
    stepRunId: string,
  ): Promise<Pick<AgentExecutionRecord, "id" | "status" | "result">> {
    const candidate = readDispatchExecution(result);
    if (candidate !== undefined) return candidate;
    const database = this.options.database;
    const existing =
      database === null
        ? undefined
        : await database.findAgentExecutionByWorkflowStepRunId(stepRunId);
    if (existing !== undefined) return existing;
    throw new Error(`durable dispatch returned no execution: ${durableExecutionId(intent)}`);
  }
}

function buildStepIntent(
  configuration: CompiledProjectConfiguration,
  trigger: CompiledProjectConfiguration["triggers"][number],
  step: CompiledProjectConfiguration["triggers"][number]["steps"][number],
  run: Extract<Awaited<ReturnType<Database["findTriggerRunById"]>>, { outcome: "accepted" }>,
  context: ExpressionContext,
  stepRunId: string,
  deadlineAt: Date,
): LaunchMachineIntent {
  const environmentName = authorityString(
    renderExpressionTemplate(step.environment, context),
    "environment",
  );
  const environment = configuration.environments.find(
    (candidate) => candidate.name === environmentName,
  );
  if (
    environment === undefined ||
    environment.kind !== "daemon" ||
    environment.daemonId === undefined
  ) {
    throw new Error(`workflow environment ${environmentName} is unavailable`);
  }
  const agent = {
    provider: authorityString(
      renderExpressionTemplate(step.agent.provider, context),
      "agent.provider",
    ),
    mode: authorityString(renderExpressionTemplate(step.agent.mode, context), "agent.mode"),
    ...(step.agent.model === undefined
      ? {}
      : {
          model: authorityString(
            renderExpressionTemplate(step.agent.model, context),
            "agent.model",
          ),
        }),
    ...(step.agent.thinkingOptionId === undefined
      ? {}
      : {
          thinkingOptionId: authorityString(
            renderExpressionTemplate(step.agent.thinkingOptionId, context),
            "agent.thinkingOptionId",
          ),
        }),
  };
  return {
    ...buildLaunchMachineIntent({
      organizationId: run.organizationId,
      projectId: run.projectId,
      triggerId: run.triggerId,
      triggerName: run.configuredTriggerName,
      environmentName,
      environment: {
        kind: "daemon",
        daemonId: environment.daemonId,
        authoredSlug: environment.daemon,
        cwd: environment.cwd,
        ...(environment.worktree === undefined ? {} : { worktree: environment.worktree }),
      },
      prompt: step.prompt
        .map((block) =>
          renderExpressionTemplate(block.kind === "text" ? block.value : block.content, context),
        )
        .join("\n"),
      agent,
      allowOutputs: step.allowOutputs,
      timeoutMs: step.maxRuntimeMs,
      idleTimeoutMs: step.idleTimeoutMs,
      autoArchive: step.autoArchive,
      triggerContext: run.triggerContext,
      outputContext: run.outputContext,
      configurationRevisionId: run.configurationRevisionId,
      hubConfig: configuration,
    }),
    workflowStepRunId: stepRunId,
    ...(step.output === undefined ? {} : { outputSchema: step.output.schema }),
    deadlineAt,
  };
}

function workflowContext(
  run: Extract<Awaited<ReturnType<Database["findTriggerRunById"]>>, { outcome: "accepted" }>,
  steps: readonly { stepId: string; status: string; output: unknown }[],
  values: Readonly<Record<string, import("./expression.js").Expression>>,
): ExpressionContext {
  return {
    prompt: run.prompt,
    inputs: inputContext(run.inputs),
    steps: Object.fromEntries(
      steps.map((step) => [step.stepId, { status: step.status, output: step.output }]),
    ),
    values,
  };
}

function authorityString(value: string, field: string): string {
  if (value.length === 0) throw new Error(`${field} resolved to an empty authority`);
  return value;
}

function inputContext(value: unknown): Readonly<Record<string, JsonPrimitive>> {
  if (!isRecord(value)) return {};
  const inputs: Record<string, JsonPrimitive> = {};
  for (const [name, input] of Object.entries(value)) {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean" ||
      (typeof input === "number" && Number.isFinite(input))
    ) {
      inputs[name] = input;
    }
  }
  return inputs;
}

function asProjectConfiguration(
  configuration: Awaited<ReturnType<typeof parseCompiledHubConfig>>,
): CompiledProjectConfiguration {
  const environments: CompiledProjectConfiguration["environments"] = configuration.environments.map(
    (environment) => {
      if (environment.kind !== "daemon") return environment;
      if (environment.daemonId === undefined)
        throw new Error(`daemon environment ${environment.name} is not activated`);
      return {
        name: environment.name,
        kind: "daemon",
        daemon: environment.daemon,
        daemonId: environment.daemonId,
        cwd: environment.cwd,
        ...(environment.worktree === undefined ? {} : { worktree: environment.worktree }),
      };
    },
  );
  return { environments, triggers: configuration.triggers };
}

function truthy(value: unknown): boolean {
  return value !== false && value !== null && value !== undefined && value !== 0 && value !== "";
}

async function collectProviderMatches(
  providers: readonly TriggerProvider[],
  trigger: DurableTrigger,
): Promise<readonly TriggerProviderMatch[]> {
  if (!isTriggerEventName(trigger.source)) return [];
  const matchingProviders = providers.filter((provider) =>
    provider.eventNames.some((name) => name === trigger.source),
  );
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
  return { id: value["id"], status: readExecutionStatus(value["status"]), result: value["result"] };
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

export function createDurableWorkflowHandler(options: DurableWorkflowEngineOptions): {
  handler: TriggerHandler;
  engine: DurableWorkflowEngine;
} {
  const engine = new DurableWorkflowEngine(options);
  return { handler: (trigger) => engine.enqueue(trigger), engine };
}
