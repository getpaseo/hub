import {
  buildExecutionCapabilityMcpServer,
  deriveAgentExecutionCompletionToken,
  hashAgentExecutionCompletionToken,
  verifyAgentExecutionCompletionToken,
} from "../agent-executions/completion-token.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentExecutionRecord,
  Database,
  DaemonRecord,
  HubAction,
  TransitionAgentExecutionFields,
  TransitionAgentExecutionResult,
  WorkflowAgentCompletionInput,
} from "../db/types.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { logger as defaultLogger } from "../logger.js";
import type { TriggerProvider } from "../triggers/index.js";
import type { ProviderIntegrationRegistration } from "../providers/registration.js";
import {
  notifyAgentExecutionCompleted,
  notifyAgentExecutionFailed,
  notifyAgentExecutionStarted,
  notifyAgentExecutionTerminal,
  notifyMachineTerminated,
} from "../triggers/lifecycle.js";
import {
  DaemonCreateResponseLostError,
  type DaemonAgentSnapshot,
  type DaemonAgentStreamEvent,
  type DaemonConnection,
  type DaemonCreateAgentOptions,
  type DaemonEvent,
} from "./protocol.js";
import type { JsonValue } from "../config/compiler.js";
import { compileJsonSchema, formatJsonSchemaErrors } from "../workflows/json-schema.js";
import type { Logger } from "pino";

export interface DaemonDispatchResult {
  execution: AgentExecutionRecord;
  agentId: string;
}

interface PreparedDaemonDispatch {
  intent: LaunchMachineIntent;
  daemon: DaemonRecord;
  execution: AgentExecutionRecord;
  completionToken: string;
  deadlineAt: Date;
  publicBaseUrl: string;
}

interface HubExecutionEnv {
  executionId: string;
  completionToken: string;
  publicBaseUrl: string;
}

const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_EXECUTION_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 5 * 60_000;

type AgentStatus = NonNullable<DaemonAgentSnapshot["state"]>["status"];
interface ExecutionDeadline {
  kind: "hard" | "idle";
  at: Date;
}

export interface ExecutionDeadlineClock {
  now(): number;
  schedule(callback: () => Promise<void>, delayMs: number): () => void;
}

const systemExecutionDeadlineClock: ExecutionDeadlineClock = {
  now: Date.now,
  schedule(callback, delayMs) {
    const timer = setTimeout(() => {
      void callback();
    }, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface DaemonDispatchLifecycleOptions {
  database: Database;
  connectionForDaemon(daemonId: string): DaemonConnection | undefined;
  providers?: readonly TriggerProvider[];
  integrations?: readonly ProviderIntegrationRegistration[];
  publicBaseUrl?: string;
  completionTokenSecret?: string;
  test?: {
    logger?: Logger;
    dispatchTimeoutMs?: number;
    deadlineClock?: ExecutionDeadlineClock;
  };
}

export class DaemonDispatchFailure extends Error {
  constructor(
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`daemon dispatch failed: ${reason}`);
    this.name = "DaemonDispatchFailure";
    this.cause = options?.cause;
  }
}

export class DaemonSpawnAckTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super("timed out waiting for daemon spawn ack");
    this.name = "DaemonSpawnAckTimeoutError";
  }
}

export class AgentExecutionCompletionFailure extends Error {
  constructor(readonly reason: "not_found" | "unauthorized" | "expired") {
    super(`agent execution completion failed: ${reason}`);
    this.name = "AgentExecutionCompletionFailure";
  }
}

export class AgentExecutionOutputValidationFailure extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`invalid structured output: ${errors.join("; ")}`);
    this.name = "AgentExecutionOutputValidationFailure";
  }
}

export class DaemonDispatchLifecycle {
  private readonly providersByName: Map<string, TriggerProvider>;
  private readonly startedExecutions = new Set<string>();
  private readonly pendingStreamHandlersByExecution = new Map<string, Promise<void>>();
  private readonly completionWatchersByExecution = new Map<
    string,
    (failure?: DaemonDispatchFailure) => void
  >();
  private readonly deadlineTimersByExecution = new Map<string, () => void>();
  private readonly activeExecutionDispatches = new Map<string, Promise<unknown>>();
  private readonly reconcilingHubActions = new Map<string, Promise<void>>();
  private readonly daemonRecoveries = new Set<Promise<void>>();
  private readonly recoveredSubscriptions = new Map<string, () => void>();
  private stopping = false;

  constructor(private readonly options: DaemonDispatchLifecycleOptions) {
    this.providersByName = new Map(
      (options.providers ?? []).map((provider) => [provider.name, provider]),
    );
  }

  activeRecoveryObservationCount(): number {
    return this.recoveredSubscriptions.size;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const unsubscribe of this.recoveredSubscriptions.values()) unsubscribe();
    this.recoveredSubscriptions.clear();
    for (const clear of this.deadlineTimersByExecution.values()) clear();
    this.deadlineTimersByExecution.clear();
    this.startedExecutions.clear();
    await Promise.allSettled([
      ...this.daemonRecoveries,
      ...this.reconcilingHubActions.values(),
      ...this.pendingStreamHandlersByExecution.values(),
      ...this.activeExecutionDispatches.values(),
    ]);
  }

  async dispatchLaunchMachineIntent(intent: LaunchMachineIntent): Promise<DaemonDispatchResult> {
    const prepared = await this.prepareDispatch(intent);
    if (prepared === undefined) throw new Error("synchronous dispatch was not prepared");
    return this.spawnPreparedDispatch(prepared);
  }

  async handoffLaunchMachineIntent(
    intent: LaunchMachineIntent,
  ): Promise<{ execution: AgentExecutionRecord }> {
    const executionId = durableExecutionId(intent);
    const prepared = await this.prepareDispatch(intent, executionId);
    if (prepared === undefined) {
      const execution = await this.options.database.findAgentExecutionById(executionId);
      if (execution === undefined) {
        throw new Error(`claimed durable execution not found: ${executionId}`);
      }
      const resumable = await this.prepareClaimedDurableDispatch(execution);
      if (resumable !== undefined) this.startDurableDispatch(resumable, true);
      return { execution };
    }
    this.startDurableDispatch(prepared, true);
    return { execution: prepared.execution };
  }

  async handoffLaunchMachineIntents(
    intents: readonly LaunchMachineIntent[],
  ): Promise<{ executions: AgentExecutionRecord[] }> {
    if (intents.length === 0) return { executions: [] };
    const prepared: PreparedDaemonDispatch[] = [];
    const executions: AgentExecutionRecord[] = [];
    const prelaunchFailures: AgentExecutionRecord[] = [];
    for (const intent of intents) {
      const executionId = durableExecutionId(intent);
      let candidate: PreparedDaemonDispatch | undefined;
      try {
        candidate = await this.prepareDispatch(intent, executionId);
      } catch (error) {
        if (!isDurablePrelaunchFailure(error)) throw error;
        const execution = await this.claimFailedDurableDispatch(intent, executionId, error.reason);
        executions.push(execution);
        prelaunchFailures.push(execution);
        continue;
      }
      if (candidate === undefined) {
        const execution = await this.options.database.findAgentExecutionById(executionId);
        if (execution === undefined) {
          throw new Error(`claimed durable execution not found: ${executionId}`);
        }
        const resumable = await this.prepareClaimedDurableDispatch(execution);
        if (resumable !== undefined) prepared.push(resumable);
        executions.push(execution);
      } else {
        prepared.push(candidate);
        executions.push(candidate.execution);
      }
    }

    const notifyAccepted = true;
    for (const candidate of prepared) {
      this.startDurableDispatch(candidate, false);
    }
    const acceptanceNotification = notifyAccepted
      ? this.notifyDispatchAccepted(intents[0]!)
      : Promise.resolve();
    for (const execution of prelaunchFailures) {
      this.notifyPrelaunchFailure(execution, acceptanceNotification);
    }
    return { executions };
  }

  private async claimFailedDurableDispatch(
    intent: LaunchMachineIntent,
    executionId: string,
    reason: string,
  ): Promise<AgentExecutionRecord> {
    const inserted = await this.options.database.insertAgentExecutionIfAbsent({
      id: executionId,
      organizationId: intent.organizationId,
      projectId: intent.projectId,
      triggerId: intent.triggerId,
      machineId: null,
      daemonId: null,
      triggerContext: intent.triggerContext,
      outputContext: intent.outputContext,
      configurationRevisionId: intent.configurationRevisionId,
      launchIntent: intent,
      workflowStepRunId: intent.workflowStepRunId ?? null,
    });
    if (inserted !== undefined) {
      return (
        await this.options.database.completeWorkflowAgentExecution({
          executionId,
          executionStatus: "failed",
          stepStatus: "failed",
          result: { status: "failed", reason },
          stepOutput: { status: "failed", reason },
          failureReason: reason,
          hubAction: null,
        })
      ).execution;
    }

    const existing = await this.options.database.findAgentExecutionById(executionId);
    if (existing === undefined) {
      throw new Error(`claimed durable execution not found: ${executionId}`);
    }
    if (existing.status === "spawning") {
      if (existing.workflowStepRunId !== null) {
        return (
          await this.options.database.completeWorkflowAgentExecution({
            executionId,
            executionStatus: "failed",
            stepStatus: "failed",
            result: { status: "failed", reason },
            stepOutput: { status: "failed", reason },
            failureReason: reason,
            hubAction: null,
          })
        ).execution;
      }
      return (
        await this.options.database.transitionAgentExecution(executionId, "failed", {
          result: { reason },
          hubAction: null,
        })
      ).execution;
    }
    return existing;
  }

  private notifyPrelaunchFailure(execution: AgentExecutionRecord, after: Promise<void>): void {
    if (this.activeExecutionDispatches.has(execution.id)) return;
    const tracked = after
      .then(() => this.notifyExecutionLifecycle(execution, executionFailureReason(execution)))
      .catch((error: unknown) => {
        this.logger.error(
          {
            err: error,
            executionId: execution.id,
            triggerId: execution.triggerId,
          },
          "prelaunch failure lifecycle notification failed",
        );
      })
      .finally(() => {
        if (this.activeExecutionDispatches.get(execution.id) === tracked) {
          this.activeExecutionDispatches.delete(execution.id);
        }
      });
    this.activeExecutionDispatches.set(execution.id, tracked);
  }

  private async prepareDispatch(
    intent: LaunchMachineIntent,
    durableId?: string,
  ): Promise<PreparedDaemonDispatch | undefined> {
    if (!this.options.completionTokenSecret) {
      throw new DaemonDispatchFailure("completion_auth_not_configured");
    }
    if (this.options.publicBaseUrl === undefined) {
      throw new DaemonDispatchFailure("completion_url_not_configured");
    }

    const daemon = await this.options.database.findDaemonForOrganization(
      intent.organizationId,
      intent.environment.daemonId,
    );

    if (daemon === undefined) {
      throw new DaemonDispatchFailure("daemon_not_registered", {
        cause: new Error(`Daemon not registered: ${intent.environment.authoredSlug}`),
      });
    }

    const [trigger, config, daemonMachine] = await Promise.all([
      this.options.database.findTriggerById(intent.triggerId),
      this.options.database.findProjectConfigurationRevision(
        intent.projectId,
        intent.configurationRevisionId,
      ),
      this.options.database.findMachineForOrganization(intent.organizationId, daemon.machineId),
    ]);
    if (
      trigger?.organizationId !== intent.organizationId ||
      trigger.projectId !== intent.projectId ||
      config?.projectId !== intent.projectId ||
      daemonMachine?.orgId !== intent.organizationId
    ) {
      throw new DaemonDispatchFailure("tenant_authority_mismatch");
    }

    const executionId = durableId ?? randomUUID();
    const completionToken = this.completionToken(executionId);
    const deadlineAt =
      intent.deadlineAt ??
      new Date(this.now() + (intent.timeoutMs ?? DEFAULT_AGENT_EXECUTION_TIMEOUT_MS));
    const executionInput = {
      id: executionId,
      organizationId: intent.organizationId,
      projectId: intent.projectId,
      triggerId: intent.triggerId,
      machineId: daemon.machineId,
      daemonId: daemon.id,
      triggerContext: intent.triggerContext,
      outputContext: intent.outputContext,
      configurationRevisionId: intent.configurationRevisionId,
      completionTokenHash: hashAgentExecutionCompletionToken(completionToken),
      deadlineAt,
      workflowStepRunId: intent.workflowStepRunId ?? null,
      launchIntent: intent,
    };
    const execution =
      durableId === undefined
        ? await this.options.database.insertAgentExecution(executionInput)
        : await this.options.database.insertAgentExecutionIfAbsent(executionInput);
    if (execution === undefined) return undefined;

    return {
      intent,
      daemon,
      execution,
      completionToken,
      deadlineAt,
      publicBaseUrl: this.options.publicBaseUrl,
    };
  }

  private async prepareClaimedDurableDispatch(
    execution: AgentExecutionRecord,
  ): Promise<PreparedDaemonDispatch | undefined> {
    if (execution.status !== "spawning" || execution.daemonAgentId !== null) return undefined;
    const intent = execution.launchIntent;
    if (
      intent === null ||
      execution.daemonId === null ||
      execution.deadlineAt === null ||
      this.options.publicBaseUrl === undefined
    ) {
      throw new Error(`durable execution cannot be resumed: ${execution.id}`);
    }
    const daemon = await this.options.database.findDaemonById(execution.daemonId);
    if (daemon === undefined) throw new Error(`daemon not found: ${execution.daemonId}`);
    return {
      intent,
      daemon,
      execution,
      completionToken: this.completionToken(execution.id),
      deadlineAt: execution.deadlineAt,
      publicBaseUrl: this.options.publicBaseUrl,
    };
  }

  private startDurableDispatch(prepared: PreparedDaemonDispatch, notifyAccepted: boolean): void {
    if (this.activeExecutionDispatches.has(prepared.execution.id)) return;
    const tracked = this.spawnPreparedDispatch(prepared, notifyAccepted)
      .catch((error: unknown) => {
        this.logger.error(
          {
            err: error,
            executionId: prepared.execution.id,
            triggerId: prepared.intent.triggerId,
          },
          "durable trigger dispatch failed after handoff",
        );
      })
      .finally(() => {
        if (this.activeExecutionDispatches.get(prepared.execution.id) === tracked) {
          this.activeExecutionDispatches.delete(prepared.execution.id);
        }
      });
    this.activeExecutionDispatches.set(prepared.execution.id, tracked);
  }

  private async spawnPreparedDispatch(
    prepared: PreparedDaemonDispatch,
    notifyAccepted = true,
  ): Promise<DaemonDispatchResult> {
    const { intent, daemon, execution, completionToken, deadlineAt, publicBaseUrl } = prepared;
    try {
      const provider = this.findProviderForTriggerContext(intent.triggerContext);
      if (notifyAccepted) {
        await provider?.onDispatchAccepted?.(intent.triggerContext, intent.outputContext);
      }

      const agentId = await this.acquireAndSpawnAgent(
        {
          daemonId: daemon.id,
          machineId: daemon.machineId,
          executionId: execution.id,
          triggerId: intent.triggerId,
          ...optionalDeliveryId(intent.triggerContext),
          intent,
          hubExecutionEnv: {
            executionId: execution.id,
            completionToken,
            publicBaseUrl,
          },
        },
        deadlineAt,
      );

      return { execution, agentId };
    } catch (error) {
      if (error instanceof DaemonCreateResponseLostError) throw error;
      const failure = toDaemonDispatchFailure(error);
      this.logDispatchFailure(failure, {
        daemonId: intent.environment.daemonId,
        authoredSlug: intent.environment.authoredSlug,
        machineId: daemon.machineId,
        executionId: execution.id,
        triggerId: intent.triggerId,
        ...optionalDeliveryId(intent.triggerContext),
      });
      await this.failAgentExecution(execution.id, failure.reason);
      throw failure;
    }
  }

  private async materializeLaunch(
    intent: LaunchMachineIntent,
    provider: TriggerProvider | undefined,
    executionId: string,
  ): Promise<LaunchMachineIntent> {
    const persistedWorktree = intent.environment.worktree;
    if (provider?.materializeLaunch === undefined) {
      return intent;
    }
    const materialized = await provider.materializeLaunch({
      executionId,
      organizationId: intent.organizationId,
      projectId: intent.projectId,
      prompt: intent.prompt,
      ...(intent.environment.env === undefined ? {} : { environmentEnv: intent.environment.env }),
      ...(persistedWorktree === undefined ? {} : { environmentWorktree: persistedWorktree }),
      triggerContext: intent.triggerContext,
    });
    const {
      env: _persistedEnvironmentEnv,
      worktree: _persistedWorktree,
      ...environment
    } = intent.environment;
    const environmentWorktree = materialized.environmentWorktree ?? persistedWorktree;
    return {
      ...intent,
      prompt: materialized.prompt,
      environment: {
        ...environment,
        ...(materialized.environmentEnv === undefined ? {} : { env: materialized.environmentEnv }),
        ...(environmentWorktree === undefined ? {} : { worktree: environmentWorktree }),
      },
    };
  }

  private async buildCreateAgentOptions(
    intent: LaunchMachineIntent,
    hubExecutionEnv: HubExecutionEnv,
  ): Promise<DaemonCreateAgentOptions> {
    const provider = this.findProviderForTriggerContext(intent.triggerContext);
    return buildCreateAgentOptions(
      await this.materializeLaunch(intent, provider, hubExecutionEnv.executionId),
      hubExecutionEnv,
    );
  }

  private async createAgent(
    connection: DaemonConnection,
    intent: LaunchMachineIntent,
    hubExecutionEnv: HubExecutionEnv,
  ): Promise<Awaited<ReturnType<DaemonConnection["createAgent"]>>> {
    return connection.createAgent(await this.buildCreateAgentOptions(intent, hubExecutionEnv));
  }

  async handleAgentStreamEvent(executionId: string, event: DaemonAgentStreamEvent): Promise<void> {
    switch (event.type) {
      case "thread_started":
        await this.startAgentExecution(executionId);
        return;
      case "timeline":
        return;
      case "turn_completed":
      case "turn_failed":
      case "turn_canceled":
        return;
      case "permission_requested":
      case "permission_resolved":
      case "turn_started":
      case "attention_required":
        return;
    }

    return assertNeverAgentStreamEvent(event);
  }

  private async handleDaemonEvent(
    executionId: string,
    daemonId: string,
    event: DaemonEvent,
  ): Promise<void> {
    if (event.type === "agent_stream") {
      await this.handleAgentStreamEvent(executionId, event.event);
      return;
    }
    if (isInterruptedAgentState(event.agent)) {
      await this.options.database.attachAgentToExecution(executionId, daemonId, event.agentId);
    }
    await this.handleAgentStatus(executionId, event.agent.status, "live");
  }

  private async handleAgentStatus(
    executionId: string,
    status: AgentStatus,
    source: "live" | "restore",
  ): Promise<void> {
    if (status === "error" || status === "closed") {
      const failed = await this.failAgentExecution(executionId, "agent_interrupted");
      if (failed !== undefined) {
        this.completionWatchersByExecution.get(executionId)?.(
          new DaemonDispatchFailure("agent_interrupted"),
        );
      }
      return;
    }

    let execution = await this.options.database.findAgentExecutionById(executionId);
    if (execution === undefined || isTerminalExecutionStatus(execution.status)) return;
    if ((status === "running" || status === "idle") && execution.status === "spawning") {
      await this.startAgentExecution(executionId);
      execution = await this.options.database.findAgentExecutionById(executionId);
      if (execution === undefined || isTerminalExecutionStatus(execution.status)) return;
    }

    let idleDeadlineAt: Date | null = null;
    if (status === "idle") {
      idleDeadlineAt =
        source === "restore" && execution.idleDeadlineAt !== null
          ? execution.idleDeadlineAt
          : new Date(
              Math.min(
                this.now() +
                  (execution.launchIntent?.idleTimeoutMs ?? DEFAULT_AGENT_IDLE_TIMEOUT_MS),
                execution.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY,
              ),
            );
    }
    const updated = await this.options.database.setAgentExecutionIdleDeadline(
      executionId,
      idleDeadlineAt,
    );
    this.armExecutionDeadline(updated);
  }

  async completeAgentExecutionFromCallback(input: {
    executionId: string;
    token: string;
    output?: unknown;
  }): Promise<AgentExecutionRecord> {
    const existingExecution = await this.options.database.findAgentExecutionById(input.executionId);
    if (existingExecution === undefined) {
      throw new AgentExecutionCompletionFailure("not_found");
    }

    if (
      existingExecution.completionTokenHash === null ||
      !verifyAgentExecutionCompletionToken(input.token, existingExecution.completionTokenHash)
    ) {
      throw new AgentExecutionCompletionFailure("unauthorized");
    }

    if (isTerminalExecutionStatus(existingExecution.status)) {
      return existingExecution;
    }

    await this.waitForPendingStreamHandlers(input.executionId);
    const currentExecution = await this.options.database.findAgentExecutionById(input.executionId);
    if (currentExecution === undefined) {
      throw new AgentExecutionCompletionFailure("not_found");
    }
    if (isTerminalExecutionStatus(currentExecution.status)) {
      return currentExecution;
    }
    if (await this.expireExecutionIfDeadlineElapsed(currentExecution)) {
      throw new AgentExecutionCompletionFailure("expired");
    }

    if (currentExecution.launchIntent?.outputSchema !== undefined) {
      validateStructuredOutput(currentExecution.launchIntent.outputSchema, input.output);
    }
    this.clearExecutionDeadline(input.executionId);
    const execution = await this.completeAgentExecution(input.executionId, {
      completedByAgent: true,
      ...(input.output === undefined ? {} : { output: input.output }),
    });
    this.completionWatchersByExecution.get(input.executionId)?.();
    return execution;
  }

  async recoverAgentExecutionDeadlines(): Promise<void> {
    const executions = await this.options.database.findPendingAgentExecutions();
    for (const execution of executions) {
      try {
        if (await this.expireExecutionIfDeadlineElapsed(execution)) {
          continue;
        }
        this.armExecutionDeadline(execution);
      } catch (error: unknown) {
        this.logger.error(
          { err: error, agent_execution_id: execution.id },
          "execution deadline recovery failed",
        );
      }
    }
  }

  async recoverPendingHubActions(daemonId?: string): Promise<void> {
    const executions = await this.options.database.findPendingHubActions(daemonId);
    await Promise.all(executions.map((execution) => this.reconcileHubActionSafely(execution)));
  }

  recoverDaemon(daemon: DaemonRecord): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const recovery = Promise.all([
      this.recoverPendingHubActions(daemon.id),
      this.recoverLiveExecutions(daemon),
    ]).then(() => undefined);
    this.daemonRecoveries.add(recovery);
    void recovery.then(
      () => this.daemonRecoveries.delete(recovery),
      () => this.daemonRecoveries.delete(recovery),
    );
    return recovery;
  }

  private async recoverLiveExecutions(daemon: DaemonRecord): Promise<void> {
    const executions = await this.options.database.findPendingAgentExecutions();
    await Promise.all(
      executions
        .filter(
          (execution) =>
            execution.daemonId === daemon.id ||
            (execution.daemonId === null && execution.machineId === daemon.machineId),
        )
        .map((execution) => this.recoverExecutionOnce(daemon, execution)),
    );
  }

  private recoverExecutionOnce(
    daemon: DaemonRecord,
    execution: AgentExecutionRecord,
  ): Promise<void> {
    const active = this.activeExecutionDispatches.get(execution.id);
    if (active) {
      return active.then(async () => {
        const current = await this.options.database.findAgentExecutionById(execution.id);
        if (current !== undefined && isResumableDurableExecution(current)) {
          return this.recoverExecutionOnce(daemon, current);
        }
        return undefined;
      });
    }
    const recovery = this.recoverExecution(daemon, execution)
      .catch((error: unknown) => {
        if (!this.stopping) {
          this.logger.error(
            {
              err: error,
              agent_execution_id: execution.id,
              daemon_id: daemon.id,
            },
            "execution daemon recovery failed",
          );
        }
      })
      .finally(() => {
        if (this.activeExecutionDispatches.get(execution.id) === recovery)
          this.activeExecutionDispatches.delete(execution.id);
      });
    this.activeExecutionDispatches.set(execution.id, recovery);
    return recovery;
  }

  private async recoverExecution(
    daemon: DaemonRecord,
    execution: AgentExecutionRecord,
  ): Promise<void> {
    const connection = this.options.connectionForDaemon(daemon.id);
    if (connection === undefined) return;

    const current = await this.options.database.findAgentExecutionById(execution.id);
    if (current === undefined || isTerminalExecutionStatus(current.status)) return;
    if (this.stopping) return;

    const intent = current.launchIntent;
    if (intent === null || this.options.publicBaseUrl === undefined)
      throw new Error("execution launch intent cannot be recovered");
    this.subscribeRecoveredExecution(current.id, daemon.id, connection);
    this.armExecutionDeadline(current);
    const agent = await this.createAgent(connection, intent, {
      executionId: current.id,
      completionToken: this.completionToken(current.id),
      publicBaseUrl: this.options.publicBaseUrl,
    });
    if (isInterruptedAgentState(agent.state)) {
      await this.failAgentExecution(current.id, "agent_interrupted");
      return;
    }
    await this.options.database.attachAgentToExecution(current.id, daemon.id, agent.id);
    await this.restoreAgentState(current.id, agent);
  }

  private subscribeRecoveredExecution(
    executionId: string,
    daemonId: string,
    connection: DaemonConnection,
  ): void {
    this.recoveredSubscriptions.get(executionId)?.();
    this.recoveredSubscriptions.set(
      executionId,
      connection.on(async (event) => {
        if (event.executionId !== executionId) return;
        await this.queueDaemonEvent(executionId, daemonId, event);
      }),
    );
  }

  private async restoreAgentState(executionId: string, agent: DaemonAgentSnapshot): Promise<void> {
    if (agent.state === undefined) {
      await this.startAgentExecution(executionId);
      return;
    }
    await this.handleAgentStatus(executionId, agent.state.status, "restore");
  }

  async failPendingExecutionsForDisconnectedMachine(
    machineId: string,
    reason: string,
  ): Promise<void> {
    const executions = (await this.options.database.findPendingAgentExecutions()).filter(
      (execution) => execution.machineId === machineId,
    );

    const failedExecutions = await Promise.all(
      executions.map(async (execution) => {
        const failed = await this.failAgentExecution(execution.id, "daemon_disconnected", {
          notifyProvider: false,
        });
        return failed === undefined ? undefined : execution;
      }),
    );

    await this.options.database.transitionMachine(machineId, "terminated", {
      reason,
    });

    await Promise.all(
      failedExecutions.map((execution) =>
        execution === undefined
          ? Promise.resolve()
          : this.notifyMachineTerminatedForExecution(execution, reason).catch((error: unknown) => {
              this.logger.error({ err: error }, "provider machine termination hook failed");
            }),
      ),
    );
  }

  private async startAgentExecution(executionId: string): Promise<void> {
    const alreadyStarted = this.startedExecutions.has(executionId);
    this.startedExecutions.add(executionId);
    const transition = await this.options.database.transitionAgentExecution(executionId, "running");

    if (alreadyStarted || !transition.transitioned) {
      return;
    }

    const { execution } = transition;
    await this.notifyExecutionLifecycle(execution).catch((error: unknown) => {
      this.logger.error({ err: error }, "provider start hook failed");
    });
  }

  private async completeAgentExecution(
    executionId: string,
    options: { completedByAgent?: boolean; output?: unknown } = {},
  ): Promise<AgentExecutionRecord> {
    const existing = await this.options.database.findAgentExecutionById(executionId);
    if (existing === undefined) throw new Error(`agent execution not found: ${executionId}`);
    const structuredOutput =
      existing.launchIntent?.outputSchema === undefined || options.output === undefined
        ? undefined
        : jsonValue(options.output);
    const transition = await this.transitionTerminalAgentExecution(
      executionId,
      "succeeded",
      {
        result:
          structuredOutput === undefined
            ? { status: "succeeded" }
            : { status: "succeeded", output: options.output },
        completedByAgent: options.completedByAgent === true,
      },
      {
        stepStatus: "succeeded",
        stepOutput: structuredOutput,
      },
    );
    if (!transition.transitioned) {
      if (isTerminalExecutionStatus(transition.execution.status)) {
        this.releaseExecutionResources(executionId);
      }
      return transition.execution;
    }

    this.clearExecutionDeadline(executionId);
    this.releaseExecutionResources(executionId);

    const { execution } = transition;
    this.startedExecutions.delete(executionId);
    await this.notifyExecutionTerminal(execution);
    await this.reconcileHubActionSafely(execution);
    await this.notifyExecutionLifecycle(execution).catch((error: unknown) => {
      this.logger.error({ err: error }, "provider completion hook failed");
    });

    return execution;
  }

  private async failAgentExecution(
    executionId: string,
    reason: string,
    details: {
      lastInvalidOutput?: unknown;
      notifyProvider?: boolean;
      deadlineCondition?: {
        kind: "hard" | "idle";
        deadlineAt: Date;
        observedAt: Date;
      };
    } = {},
  ): Promise<AgentExecutionRecord | undefined> {
    const current = await this.options.database.findAgentExecutionById(executionId);
    if (current === undefined) throw new Error(`agent execution not found: ${executionId}`);
    const result = {
      status: "failed" as const,
      reason,
      ...(details.lastInvalidOutput === undefined
        ? {}
        : { lastInvalidOutput: details.lastInvalidOutput }),
    };
    const stepStatus =
      details.deadlineCondition?.kind === "hard" &&
      current.deadlineAt !== null &&
      current.deadlineAt.getTime() <= this.now()
        ? ("timed_out" as const)
        : ("failed" as const);
    const transition = await this.transitionTerminalAgentExecution(
      executionId,
      "failed",
      {
        result,
        ...(details.deadlineCondition === undefined
          ? {}
          : { deadlineCondition: details.deadlineCondition }),
      },
      { stepStatus, stepOutput: result, failureReason: reason },
    );
    if (!transition.transitioned) {
      if (isTerminalExecutionStatus(transition.execution.status)) {
        this.releaseExecutionResources(executionId);
      }
      return undefined;
    }

    this.clearExecutionDeadline(executionId);
    this.releaseExecutionResources(executionId);

    const { execution } = transition;
    this.startedExecutions.delete(executionId);
    await this.notifyExecutionTerminal(execution);
    await this.reconcileHubActionSafely(execution);
    if (details.notifyProvider !== false) {
      await this.notifyExecutionLifecycle(execution, reason).catch((error: unknown) => {
        this.logger.error({ err: error }, "provider failure hook failed");
      });
    }

    return execution;
  }

  private async transitionTerminalAgentExecution(
    executionId: string,
    status: "succeeded" | "failed",
    fields: TransitionAgentExecutionFields,
    workflow: Pick<WorkflowAgentCompletionInput, "stepStatus" | "stepOutput" | "failureReason">,
  ): Promise<TransitionAgentExecutionResult> {
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (execution === undefined) throw new Error(`agent execution not found: ${executionId}`);
    if (execution.workflowStepRunId !== null) {
      return this.options.database.completeWorkflowAgentExecution({
        executionId,
        executionStatus: status,
        stepStatus: workflow.stepStatus,
        result: fields.result,
        stepOutput: workflow.stepOutput,
        ...(workflow.failureReason === undefined ? {} : { failureReason: workflow.failureReason }),
        ...(fields.completedByAgent === undefined
          ? {}
          : { completedByAgent: fields.completedByAgent }),
        ...(fields.deadlineCondition === undefined
          ? {}
          : { deadlineCondition: fields.deadlineCondition }),
        hubAction: deriveHubAction(execution, status),
      });
    }
    return this.options.database.transitionAgentExecution(executionId, status, {
      ...fields,
      hubAction: deriveHubAction(execution, status),
    });
  }

  private reconcileHubActionSafely(execution: AgentExecutionRecord): Promise<void> {
    return this.reconcileHubAction(execution).catch((error: unknown) => {
      this.logger.error(
        {
          err: error,
          agent_execution_id: execution.id,
          hub_action: execution.hubAction,
        },
        "execution Hub action remains pending",
      );
    });
  }

  private reconcileHubAction(execution: AgentExecutionRecord): Promise<void> {
    if (
      this.stopping ||
      execution.hubAction === null ||
      execution.hubActionCompletedAt !== null ||
      execution.daemonId === null
    ) {
      return Promise.resolve();
    }
    const existing = this.reconcilingHubActions.get(execution.id);
    if (existing !== undefined) return existing;
    const operation = this.sendPendingHubAction(execution.id).finally(() => {
      if (this.reconcilingHubActions.get(execution.id) === operation) {
        this.reconcilingHubActions.delete(execution.id);
      }
    });
    this.reconcilingHubActions.set(execution.id, operation);
    return operation;
  }

  private async sendPendingHubAction(executionId: string): Promise<void> {
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (execution === undefined || execution.hubActionCompletedAt !== null || this.stopping) return;
    const action = execution.hubAction;
    const daemonId = execution.daemonId;
    if (action === null || daemonId === null) return;
    const connection = this.options.connectionForDaemon(daemonId);
    if (connection === undefined) return;
    await withHubActionTimeout(
      connection.controlExecution({ executionId: execution.id, action }),
      this.dispatchTimeoutMs,
      (callback, delayMs) => this.scheduleDeadline(async () => callback(), delayMs),
    );
    await this.options.database.completeHubAction(execution.id, action);
  }

  private async notifyMachineTerminated(triggerContext: unknown, reason: string): Promise<void> {
    const provider = this.findProviderForTriggerContext(triggerContext);
    if (provider === undefined) {
      return;
    }

    await notifyMachineTerminated({
      provider,
      triggerContext,
      reason,
    });
  }

  private notifyDispatchAccepted(intent: LaunchMachineIntent): Promise<void> {
    const provider = this.findProviderForTriggerContext(intent.triggerContext);
    if (provider?.onDispatchAccepted === undefined) return Promise.resolve();
    return Promise.resolve()
      .then(() => provider.onDispatchAccepted!(intent.triggerContext, intent.outputContext))
      .catch((error: unknown) => {
        this.logger.error({ err: error }, "provider acceptance hook failed");
      });
  }

  private async notifyExecutionLifecycle(
    execution: AgentExecutionRecord,
    failureReason?: string,
  ): Promise<void> {
    const provider = this.findProviderForTriggerContext(execution.triggerContext);
    if (provider === undefined) return;
    if (execution.workflowStepRunId !== null) {
      if (execution.status === "running") {
        await notifyAgentExecutionStarted({
          provider,
          triggerContext: execution.triggerContext,
          outputContext: execution.outputContext,
        });
      } else if (execution.status === "succeeded") {
        await notifyAgentExecutionCompleted({
          provider,
          triggerContext: execution.triggerContext,
          outputContext: execution.outputContext,
          result: { status: "succeeded" },
        });
      } else if (execution.status === "failed") {
        await notifyAgentExecutionFailed({
          provider,
          triggerContext: execution.triggerContext,
          outputContext: execution.outputContext,
          reason: failureReason ?? executionFailureReason(execution) ?? "agent_execution_failed",
        });
      }
      return;
    }
    await notifyIndividualExecution(provider, execution, failureReason);
  }

  private async notifyExecutionTerminal(execution: AgentExecutionRecord): Promise<void> {
    const provider = this.findProviderForTriggerContext(execution.triggerContext);
    if (provider !== undefined) {
      await notifyAgentExecutionTerminal({
        provider,
        executionId: execution.id,
        triggerContext: execution.triggerContext,
      }).catch((error: unknown) => {
        this.logger.warn(
          { err: error, agent_execution_id: execution.id },
          "provider terminal cleanup hook failed",
        );
      });
    }
    await Promise.all(
      (this.options.integrations ?? []).map(async (integration) => {
        if (integration.onExecutionTerminal === undefined) return;
        await integration.onExecutionTerminal(execution.id).catch((error: unknown) => {
          this.logger.warn(
            { err: error, agent_execution_id: execution.id },
            "integration terminal cleanup hook failed",
          );
        });
      }),
    );
  }

  private async notifyMachineTerminatedForExecution(
    execution: AgentExecutionRecord,
    reason: string,
  ): Promise<void> {
    if (execution.workflowStepRunId !== null && execution.workflowStepRunId !== undefined) {
      await this.notifyExecutionLifecycle(execution, reason);
      return;
    }
    await this.notifyMachineTerminated(execution.triggerContext, reason);
  }

  private findProviderForTriggerContext(triggerContext: unknown): TriggerProvider | undefined {
    if (typeof triggerContext !== "object" || triggerContext === null) {
      return undefined;
    }

    const providerName = hasProviderName(triggerContext) ? triggerContext.provider : undefined;
    return typeof providerName === "string" ? this.providersByName.get(providerName) : undefined;
  }

  private logDispatchFailure(
    failure: DaemonDispatchFailure,
    fields: {
      daemonId: string;
      authoredSlug: string;
      machineId: string;
      executionId: string;
      triggerId: string;
      deliveryId?: string;
    },
  ): void {
    if (failure.cause instanceof DaemonSpawnAckTimeoutError) {
      this.logger.error(
        {
          daemon_id: fields.daemonId,
          authored_slug: fields.authoredSlug,
          machine_id: fields.machineId,
          agent_execution_id: fields.executionId,
          trigger_id: fields.triggerId,
          delivery_id: fields.deliveryId,
          timeout_ms: failure.cause.timeoutMs,
        },
        "daemon timeout after 30s waiting for spawn ack",
      );
      return;
    }

    this.logger.error(
      {
        err: failure.cause,
        daemon_id: fields.daemonId,
        authored_slug: fields.authoredSlug,
        machine_id: fields.machineId,
        agent_execution_id: fields.executionId,
        trigger_id: fields.triggerId,
        delivery_id: fields.deliveryId,
        reason: failure.reason,
      },
      "daemon dispatch failed",
    );
  }

  private get logger(): Logger {
    return this.options.test?.logger ?? defaultLogger;
  }

  private get dispatchTimeoutMs(): number {
    return this.options.test?.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  }

  private async acquireAndSpawnAgent(
    input: {
      daemonId: string;
      machineId: string;
      executionId: string;
      triggerId: string;
      deliveryId?: string;
      intent: LaunchMachineIntent;
      hubExecutionEnv: HubExecutionEnv;
    },
    deadlineAt: Date,
  ): Promise<string> {
    let canceled = false;
    const cancelHandlers = new Set<() => Promise<void>>();
    const timeoutMs = Math.max(
      0,
      Math.min(this.dispatchTimeoutMs, deadlineAt.getTime() - this.now()),
    );
    try {
      return await withDispatchTimeout(
        this.acquireAndSpawnAgentWithoutTimeout(
          input,
          () => canceled,
          (handler) => {
            cancelHandlers.add(handler);
          },
        ),
        timeoutMs,
        () => {
          canceled = true;
          for (const handler of cancelHandlers) {
            void handler();
          }
        },
        (callback, delayMs) => this.scheduleDeadline(async () => callback(), delayMs),
      );
    } catch (error) {
      if (deadlineAt.getTime() <= this.now()) {
        throw new DaemonDispatchFailure("timeout", { cause: error });
      }
      throw error;
    }
  }

  private async acquireAndSpawnAgentWithoutTimeout(
    input: {
      daemonId: string;
      machineId: string;
      executionId: string;
      triggerId: string;
      deliveryId?: string;
      intent: LaunchMachineIntent;
      hubExecutionEnv: HubExecutionEnv;
    },
    isCanceled: () => boolean,
    onCancel: (handler: () => Promise<void>) => void,
  ): Promise<string> {
    const connection = this.options.connectionForDaemon(input.daemonId);
    if (connection === undefined) {
      throw new DaemonDispatchFailure("daemon_unreachable");
    }
    const pendingHandlers = new Set<Promise<void>>();
    let disposed = false;
    let settleTerminal: ((failure?: DaemonDispatchFailure) => void) | undefined;
    const terminal = new Promise<void>((resolve, reject) => {
      settleTerminal = (failure) => {
        if (failure === undefined) {
          resolve();
          return;
        }
        reject(failure);
      };
    });
    void terminal.catch(() => undefined);
    this.completionWatchersByExecution.set(input.executionId, (failure) => {
      settleTerminal?.(failure);
    });
    const cleanup = async (): Promise<void> => {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeEvents();
      this.completionWatchersByExecution.delete(input.executionId);
      await Promise.all(Array.from(pendingHandlers));
    };

    const trackHandler = (operation: Promise<void>): Promise<void> => {
      const tracked = operation.catch((error: unknown) => {
        if (!disposed) {
          this.logger.error({ err: error }, "daemon launch event handler failed");
        }
      });
      pendingHandlers.add(tracked);
      void tracked.finally(() => {
        pendingHandlers.delete(tracked);
      });
      return tracked;
    };

    const unsubscribeEvents = connection.on((event: DaemonEvent) => {
      if (event.executionId !== input.executionId) {
        return undefined;
      }
      return trackHandler(this.queueDaemonEvent(input.executionId, input.daemonId, event));
    });
    onCancel(cleanup);

    try {
      if (!(await this.armLiveExecutionDeadline(input.executionId))) {
        throw new DaemonDispatchFailure("timeout");
      }

      if (isCanceled()) {
        throw new DaemonSpawnAckTimeoutError(this.dispatchTimeoutMs);
      }
      const agent = await Promise.race([
        this.createAgent(connection, input.intent, input.hubExecutionEnv),
        terminal.then<never>(() => new Promise<never>(() => undefined)),
      ]);
      if (isCanceled()) {
        throw new DaemonSpawnAckTimeoutError(this.dispatchTimeoutMs);
      }
      await this.options.database.attachAgentToExecution(
        input.executionId,
        input.daemonId,
        agent.id,
      );
      await this.startAgentExecution(input.executionId);
      void (async () => {
        try {
          await terminal;
        } catch (error: unknown) {
          const failure = toDaemonDispatchFailure(error);
          this.logDispatchFailure(failure, {
            daemonId: input.daemonId,
            authoredSlug: input.intent.environment.authoredSlug,
            machineId: input.machineId,
            executionId: input.executionId,
            triggerId: input.triggerId,
            ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
          });
          await this.failAgentExecution(input.executionId, failure.reason);
        } finally {
          await cleanup();
        }
      })().catch((error: unknown) => {
        this.logger.error({ err: error }, "daemon dispatch watcher failed");
      });
      return agent.id;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  private async waitForPendingStreamHandlers(executionId: string): Promise<void> {
    await this.pendingStreamHandlersByExecution.get(executionId)?.catch(() => undefined);
  }

  private queueDaemonEvent(
    executionId: string,
    daemonId: string,
    event: DaemonEvent,
  ): Promise<void> {
    const previous = this.pendingStreamHandlersByExecution.get(executionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => this.handleDaemonEvent(executionId, daemonId, event));
    this.pendingStreamHandlersByExecution.set(executionId, current);
    void current.finally(() => {
      if (this.pendingStreamHandlersByExecution.get(executionId) === current) {
        this.pendingStreamHandlersByExecution.delete(executionId);
      }
    });
    return current;
  }

  private armExecutionDeadline(execution: AgentExecutionRecord): void {
    this.clearExecutionDeadline(execution.id);
    const deadline = nextExecutionDeadline(execution);
    if (deadline === undefined || isTerminalExecutionStatus(execution.status)) return;

    const delayMs = Math.max(0, deadline.at.getTime() - this.now());
    const clear = this.scheduleDeadline(async () => {
      await this.expireExecutionAtCurrentDeadline(execution.id).catch((error: unknown) => {
        this.logger.error(
          { err: error, agent_execution_id: execution.id },
          "execution timeout failed",
        );
        void this.retryExecutionDeadline(execution.id).catch((retryError: unknown) => {
          this.logger.error(
            { err: retryError, agent_execution_id: execution.id },
            "execution timeout retry setup failed",
          );
        });
      });
    }, delayMs);
    this.deadlineTimersByExecution.set(execution.id, clear);
  }

  private async armLiveExecutionDeadline(executionId: string): Promise<boolean> {
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (execution === undefined) {
      return true;
    }

    const deadline = nextExecutionDeadline(execution);
    if (deadline !== undefined && deadline.at.getTime() <= this.now()) {
      return !(await this.expireExecutionAtCurrentDeadline(executionId));
    }

    this.armExecutionDeadline(execution);
    return true;
  }

  private clearExecutionDeadline(executionId: string): void {
    const clear = this.deadlineTimersByExecution.get(executionId);
    if (clear !== undefined) {
      clear();
      this.deadlineTimersByExecution.delete(executionId);
    }
  }

  private releaseExecutionResources(executionId: string): void {
    this.recoveredSubscriptions.get(executionId)?.();
    this.recoveredSubscriptions.delete(executionId);
  }

  private async expireExecutionAtCurrentDeadline(executionId: string): Promise<boolean> {
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (execution === undefined || isTerminalExecutionStatus(execution.status)) return false;
    const deadline = nextExecutionDeadline(execution);
    if (deadline === undefined || deadline.at.getTime() > this.now()) {
      this.armExecutionDeadline(execution);
      return false;
    }

    const reason = deadline.kind === "idle" ? "idle_timeout" : "timeout";
    const failed = await this.failAgentExecution(executionId, reason, {
      deadlineCondition: {
        kind: deadline.kind,
        deadlineAt: deadline.at,
        observedAt: new Date(this.now()),
      },
    });
    if (failed !== undefined) {
      this.completionWatchersByExecution.get(executionId)?.(new DaemonDispatchFailure(reason));
      return true;
    }

    const current = await this.options.database.findAgentExecutionById(executionId);
    if (current !== undefined && !isTerminalExecutionStatus(current.status)) {
      this.armExecutionDeadline(current);
    }
    return false;
  }

  private async retryExecutionDeadline(executionId: string): Promise<void> {
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (execution === undefined || isTerminalExecutionStatus(execution.status)) {
      return;
    }

    this.clearExecutionDeadline(executionId);
    const clear = this.scheduleDeadline(async () => {
      await this.expireExecutionAtCurrentDeadline(executionId).catch((error: unknown) => {
        this.logger.error(
          { err: error, agent_execution_id: executionId },
          "execution timeout retry failed",
        );
        void this.retryExecutionDeadline(executionId).catch((retryError: unknown) => {
          this.logger.error(
            { err: retryError, agent_execution_id: executionId },
            "execution timeout retry setup failed",
          );
        });
      });
    }, 1_000);
    this.deadlineTimersByExecution.set(executionId, clear);
  }

  private async expireExecutionIfDeadlineElapsed(
    execution: AgentExecutionRecord,
  ): Promise<boolean> {
    const deadline = nextExecutionDeadline(execution);
    if (deadline === undefined || deadline.at.getTime() > this.now()) {
      return false;
    }

    return this.expireExecutionAtCurrentDeadline(execution.id);
  }

  private now(): number {
    return this.deadlineClock.now();
  }

  private scheduleDeadline(callback: () => Promise<void>, delayMs: number): () => void {
    return this.deadlineClock.schedule(callback, delayMs);
  }

  private get deadlineClock(): ExecutionDeadlineClock {
    return this.options.test?.deadlineClock ?? systemExecutionDeadlineClock;
  }

  private completionToken(executionId: string): string {
    if (!this.options.completionTokenSecret) {
      throw new DaemonDispatchFailure("completion_auth_not_configured");
    }
    return deriveAgentExecutionCompletionToken(this.options.completionTokenSecret, executionId);
  }
}

export function durableExecutionId(
  intent: Pick<
    LaunchMachineIntent,
    "triggerId" | "configurationRevisionId" | "triggerName" | "workflowStepRunId"
  >,
): string {
  const bytes = createHash("sha256")
    .update("paseo-durable-execution-v1\0")
    .update(intent.triggerId)
    .update("\0")
    .update(intent.configurationRevisionId)
    .update("\0")
    .update(intent.triggerName)
    .update("\0")
    .update(intent.workflowStepRunId ?? "")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function notifyIndividualExecution(
  provider: TriggerProvider,
  execution: AgentExecutionRecord,
  failureReason?: string,
): Promise<void> {
  if (execution.status === "failed") {
    await notifyAgentExecutionFailed({
      provider,
      triggerContext: execution.triggerContext,
      outputContext: execution.outputContext,
      reason: failureReason ?? executionFailureReason(execution) ?? "agent_execution_failed",
    });
  } else if (execution.status === "succeeded") {
    await notifyAgentExecutionCompleted({
      provider,
      triggerContext: execution.triggerContext,
      outputContext: execution.outputContext,
      result: { status: "succeeded" },
    });
  } else {
    await notifyAgentExecutionStarted({
      provider,
      triggerContext: execution.triggerContext,
      outputContext: execution.outputContext,
    });
  }
}

function executionFailureReason(execution: AgentExecutionRecord | undefined): string | undefined {
  if (typeof execution?.result !== "object" || execution.result === null) return undefined;
  const reason = (execution.result as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

function validateStructuredOutput(schema: JsonValue, output: unknown): asserts output is JsonValue {
  const validator = compileJsonSchema(schema).validate;
  if (!isJsonValue(output))
    throw new AgentExecutionOutputValidationFailure(["output must be valid JSON"]);
  if (validator(output)) return;
  const errors = formatJsonSchemaErrors(validator.errors);
  throw new AgentExecutionOutputValidationFailure(
    errors.length === 0 ? ["output is invalid"] : errors,
  );
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  }
  throw new AgentExecutionOutputValidationFailure(["output must be valid JSON"]);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && value !== null && Object.values(value).every(isJsonValue);
}

export function createDaemonDispatchLifecycle(
  options: DaemonDispatchLifecycleOptions,
): DaemonDispatchLifecycle {
  return new DaemonDispatchLifecycle(options);
}

function isTerminalExecutionStatus(status: AgentExecutionRecord["status"]): boolean {
  return status === "succeeded" || status === "failed";
}

function isResumableDurableExecution(execution: AgentExecutionRecord): boolean {
  return execution.status === "spawning" && execution.daemonAgentId === null;
}

function deriveHubAction(
  execution: AgentExecutionRecord,
  status: "succeeded" | "failed",
): HubAction | null {
  if (execution.daemonId === null) return null;
  if (execution.launchIntent?.autoArchive === true) return "archive";
  return status === "failed" ? "interrupt" : null;
}

function isInterruptedAgentState(state: DaemonAgentSnapshot["state"]): boolean {
  return state?.status === "closed" || state?.status === "error";
}

function toDaemonDispatchFailure(error: unknown): DaemonDispatchFailure {
  if (error instanceof DaemonDispatchFailure) {
    return error;
  }

  if (error instanceof DaemonSpawnAckTimeoutError) {
    return new DaemonDispatchFailure("daemon_timeout", { cause: error });
  }

  return new DaemonDispatchFailure("daemon_unreachable", { cause: error });
}

function isDurablePrelaunchFailure(error: unknown): error is DaemonDispatchFailure {
  return error instanceof DaemonDispatchFailure && error.reason === "daemon_not_registered";
}

async function buildCreateAgentOptions(
  intent: LaunchMachineIntent,
  hubExecutionEnv: {
    executionId: string;
    completionToken: string;
    publicBaseUrl: string;
  },
): Promise<DaemonCreateAgentOptions> {
  return {
    executionId: hubExecutionEnv.executionId,
    provider: intent.agent.provider,
    mode: intent.agent.mode ?? "default",
    ...(intent.agent.model === undefined ? {} : { model: intent.agent.model }),
    ...(intent.agent.thinkingOptionId === undefined
      ? {}
      : { thinkingOptionId: intent.agent.thinkingOptionId }),
    cwd: intent.environment.cwd,
    prompt: intent.prompt,
    env: buildAgentEnv(intent),
    mcpServers: {
      hub: buildExecutionCapabilityMcpServer(hubExecutionEnv),
    },
    ...(intent.environment.worktree === undefined
      ? {}
      : {
          worktree: intent.environment.worktree,
        }),
  };
}

function buildAgentEnv(intent: LaunchMachineIntent): Record<string, string> {
  return {
    ...intent.environment.env,
    PASEO_AGENT_PROVIDER: intent.agent.provider,
    PASEO_AGENT_MODE: intent.agent.mode ?? "default",
    PASEO_HUB_CONFIG_JSON: JSON.stringify(intent.hubConfig),
  };
}

function optionalDeliveryId(triggerContext: unknown): { deliveryId?: string } {
  if (typeof triggerContext !== "object" || triggerContext === null) {
    return {};
  }

  if (!("deliveryId" in triggerContext)) {
    return {};
  }

  const { deliveryId } = triggerContext;
  return typeof deliveryId === "string" ? { deliveryId } : {};
}

function nextExecutionDeadline(execution: AgentExecutionRecord): ExecutionDeadline | undefined {
  if (execution.deadlineAt === null) {
    return execution.idleDeadlineAt === null
      ? undefined
      : { kind: "idle", at: execution.idleDeadlineAt };
  }
  if (
    execution.idleDeadlineAt === null ||
    execution.deadlineAt.getTime() <= execution.idleDeadlineAt.getTime()
  ) {
    return { kind: "hard", at: execution.deadlineAt };
  }
  return { kind: "idle", at: execution.idleDeadlineAt };
}

function hasProviderName(value: object): value is { provider?: unknown } {
  return "provider" in value;
}

function assertNeverAgentStreamEvent(value: never): never {
  throw new Error(`unhandled daemon agent stream event: ${JSON.stringify(value)}`);
}

async function withDispatchTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  schedule: (callback: () => void, delayMs: number) => () => void,
): Promise<T> {
  let clearTimer: (() => void) | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        clearTimer = schedule(() => {
          onTimeout();
          reject(new DaemonSpawnAckTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimer?.();
  }
}

async function withHubActionTimeout(
  operation: Promise<void>,
  timeoutMs: number,
  schedule: (callback: () => void, delayMs: number) => () => void,
): Promise<void> {
  let clearTimer: (() => void) | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((_resolve, reject) => {
        clearTimer = schedule(
          () => reject(new Error("timed out waiting for daemon execution control ack")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimer?.();
  }
}
