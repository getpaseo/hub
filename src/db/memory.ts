import { randomUUID } from "node:crypto";
import type { AgentExecutionStatus, MachineStatus } from "./schema.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type {
  AgentExecutionRecord,
  Database,
  InsertAgentExecutionInput,
  InsertMachineInput,
  InsertTriggerInput,
  InsertTriggerResult,
  MachineRecord,
  TerminateMachineFields,
  TransitionAgentExecutionFields,
  TransitionAgentExecutionResult,
  TriggerRecord,
  EnrollDaemonInput,
  EnrollmentTokenRecord,
  DaemonRecord,
  DeviceAuthorizationRecord,
  DeviceAuthorizationDecisionInput,
  DevicePollResult,
  StartDeviceAuthorizationInput,
  AdvanceGitHubConnectionAttemptInput,
  BindDiscordConnectionInput,
  BindGitHubConnectionInput,
  BindSlackConnectionInput,
  ConnectionStartAuthority,
  ConnectionProvider,
  ReadConnectionAttemptInput,
  StartConnectionAttemptInput,
  SwitchProjectConfigurationToManualInput,
  SetProjectGitHubConfigurationSourceInput,
  RecordConfigurationSyncAttemptInput,
  ConfigurationSyncAttemptRecord,
  AcceptDiscordTriggerInput,
  AcceptGitHubTriggerInput,
  AcceptSlackTriggerInput,
  DurableTrigger,
  GitHubLifecycleClaim,
  GitHubLifecycleClaimInput,
  GitHubLifecycleResult,
  PersistManualTriggerInput,
  ProviderTriggerAcceptance,
  CreateProjectInput,
  InsertProjectConfigurationRevisionInput,
  ProjectConfigurationRevisionRecord,
  ProjectRecord,
  TenantRouteAccess,
  GitHubConnectionRecord,
  GitHubConfigurationTarget,
  DiscordConnectionRecord,
  SlackConnectionRecord,
  GitHubRepositoryRecord,
  OrganizationConnectionUsage,
  ProjectTriggerRoute,
  CreateAcceptedTriggerRunInput,
  CreateRejectedTriggerRunInput,
  AcceptedTriggerRunRecord,
  RejectedTriggerRunRecord,
  TriggerRunRecord,
  WorkflowStepExecutionInput,
  WorkflowStepRunRecord,
  WorkflowWakeupRecord,
  WorkflowAgentCompletionInput,
  WorkflowDeadlineKind,
  WorkflowDeadlineRecovery,
} from "./types.js";

export interface MemoryDatabaseOptions {
  onInsertAgentExecution?: (execution: AgentExecutionRecord) => void;
  organizationIds?: readonly string[];
  memberships?: readonly {
    userId: string;
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    membershipId: string;
    role: "owner" | "admin" | "member";
  }[];
  now?: () => Date;
}

export function createMemoryDatabase(options: MemoryDatabaseOptions = {}): Database {
  return new MemoryDatabase(options);
}

class MemoryDatabase implements Database {
  private readonly triggers = new Map<string, TriggerRecord>();
  private readonly triggersByDeliveryId = new Map<string, string>();
  private readonly triggersBySignatureHash = new Map<string, string>();
  private readonly receiptIdsByDelivery = new Map<string, string>();
  private readonly triggerIdsByReceipt = new Map<string, string[]>();
  private readonly providerReceiptActivities = new Map<string, TriggerRecord>();
  private readonly machines = new Map<string, MachineRecord>();
  private readonly agentExecutions = new Map<string, AgentExecutionRecord>();
  private readonly triggerRuns = new Map<string, TriggerRunRecord>();
  private readonly triggerRunIdsByTrigger = new Map<string, Map<string, string>>();
  private readonly workflowStepRuns = new Map<string, WorkflowStepRunRecord>();
  private readonly workflowWakeups = new Map<string, WorkflowWakeupRecord>();
  private readonly enrollmentTokens = new Map<string, EnrollmentTokenRecord>();
  private readonly deviceAuthorizations = new Map<string, MemoryDeviceAuthorization>();
  private readonly daemons = new Map<string, DaemonRecord>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly configurationRevisions = new Map<string, ProjectConfigurationRevisionRecord>();
  private readonly configurationAuthorities = new Map<string, "manual" | "github">();
  private readonly githubConfigurationSources = new Map<
    string,
    {
      githubConnectionId: string;
      githubRepositoryId: number;
      githubRepositoryFullName: string;
      githubDefaultBranch: string;
      automaticDeploymentEnabled: boolean;
    }
  >();
  private readonly configurationSyncAttempts = new Map<string, ConfigurationSyncAttemptRecord[]>();
  private readonly projectTriggerRoutes = new Map<string, ProjectTriggerRoute[]>();
  private readonly githubRepositories = new Map<string, GitHubRepositoryRecord>();
  private readonly githubConnections = new Map<number, GitHubConnectionRecord>();
  private readonly discordConnections = new Map<string, DiscordConnectionRecord>();
  private readonly slackConnections = new Map<string, SlackConnectionRecord>();
  private readonly organizationIds: Set<string>;

  constructor(private readonly options: MemoryDatabaseOptions = {}) {
    this.organizationIds = new Set(options.organizationIds);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async createAcceptedTriggerRun(
    input: CreateAcceptedTriggerRunInput,
  ): Promise<{ run: AcceptedTriggerRunRecord; created: boolean }> {
    const triggerRuns =
      this.triggerRunIdsByTrigger.get(input.triggerId) ?? new Map<string, string>();
    const existingId = triggerRuns.get(input.configuredTriggerName);
    if (existingId !== undefined) {
      const existing = this.triggerRuns.get(existingId);
      if (existing === undefined)
        throw new Error(`trigger run index points at missing row: ${existingId}`);
      if (existing.outcome !== "accepted") throw new Error("trigger branch outcome conflict");
      return { run: existing, created: false };
    }
    const now = input.createdAt ?? this.options.now?.() ?? new Date();
    const run: AcceptedTriggerRunRecord = {
      id: input.id ?? randomUUID(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      configurationRevisionId: input.configurationRevisionId,
      triggerId: input.triggerId,
      configuredTriggerName: input.configuredTriggerName,
      outcome: "accepted",
      status: "running",
      rawPrompt: input.rawPrompt,
      prompt: input.prompt,
      inputs: freezeEvidence(input.inputs),
      triggerContext: freezeEvidence(input.triggerContext),
      outputContext: freezeEvidence(input.outputContext),
      deadlineAt: input.deadlineAt,
      deadlineKind: null,
      failureReason: null,
      createdAt: now,
      completedAt: null,
    };
    this.triggerRuns.set(run.id, run);
    triggerRuns.set(input.configuredTriggerName, run.id);
    this.triggerRunIdsByTrigger.set(input.triggerId, triggerRuns);
    for (const [ordinal, stepId] of input.stepIds.entries()) {
      const step: WorkflowStepRunRecord = {
        id: randomUUID(),
        triggerRunId: run.id,
        stepId,
        ordinal,
        status: "pending",
        agentExecutionId: null,
        output: null,
        failureReason: null,
        deadlineKind: null,
        deadlineAt: null,
        idleDeadlineAt: null,
        startedAt: null,
        completedAt: null,
        dispatchIntent: null,
      };
      this.workflowStepRuns.set(step.id, step);
    }
    this.workflowWakeups.set(run.id, {
      triggerRunId: run.id,
      availableAt: now,
      leaseExpiresAt: null,
    });
    return { run, created: true };
  }

  async createRejectedTriggerRun(
    input: CreateRejectedTriggerRunInput,
  ): Promise<{ run: RejectedTriggerRunRecord; created: boolean }> {
    const triggerRuns =
      this.triggerRunIdsByTrigger.get(input.triggerId) ?? new Map<string, string>();
    const existingId = triggerRuns.get(input.configuredTriggerName);
    if (existingId !== undefined) {
      const existing = this.triggerRuns.get(existingId);
      if (existing === undefined)
        throw new Error(`trigger run index points at missing row: ${existingId}`);
      if (existing.outcome !== "rejected") throw new Error("trigger branch outcome conflict");
      return { run: existing, created: false };
    }
    const now = input.createdAt ?? this.options.now?.() ?? new Date();
    const run: RejectedTriggerRunRecord = {
      id: input.id ?? randomUUID(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      configurationRevisionId: input.configurationRevisionId,
      triggerId: input.triggerId,
      configuredTriggerName: input.configuredTriggerName,
      outcome: "rejected",
      status: "rejected",
      rawPrompt: input.rawPrompt,
      prompt: input.prompt,
      inputs: freezeEvidence(input.inputs),
      triggerContext: freezeEvidence(input.triggerContext),
      outputContext: freezeEvidence(input.outputContext),
      rejection: freezeEvidence(input.rejection),
      createdAt: now,
      completedAt: now,
    };
    this.triggerRuns.set(run.id, run);
    triggerRuns.set(input.configuredTriggerName, run.id);
    this.triggerRunIdsByTrigger.set(input.triggerId, triggerRuns);
    return { run, created: true };
  }

  async findTriggerRunById(id: string) {
    return this.triggerRuns.get(id);
  }

  async findTriggerRunsByTriggerId(triggerId: string) {
    return [...(this.triggerRunIdsByTrigger.get(triggerId)?.values() ?? [])]
      .map((id) => this.triggerRuns.get(id))
      .filter((run): run is TriggerRunRecord => run !== undefined)
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.configuredTriggerName.localeCompare(right.configuredTriggerName),
      );
  }

  async listTriggerRunsForProject(projectId: string, limit: number) {
    return [...this.triggerRuns.values()]
      .filter((run) => run.projectId === projectId)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          left.configuredTriggerName.localeCompare(right.configuredTriggerName),
      )
      .slice(0, limit);
  }

  async findWorkflowStepRunById(id: string) {
    return this.workflowStepRuns.get(id);
  }

  async findWorkflowStepRunByTriggerRun(triggerRunId: string) {
    return (await this.listWorkflowStepRunsForTriggerRun(triggerRunId))[0];
  }

  async listWorkflowStepRunsForTriggerRun(triggerRunId: string) {
    return Array.from(this.workflowStepRuns.values())
      .filter((step) => step.triggerRunId === triggerRunId)
      .sort((left, right) => left.ordinal - right.ordinal);
  }

  async findAgentExecutionByWorkflowStepRunId(stepRunId: string) {
    return Array.from(this.agentExecutions.values()).find(
      (execution) => execution.workflowStepRunId === stepRunId,
    );
  }

  async claimWorkflowWakeup(now: Date, leaseMs: number) {
    const candidate = Array.from(this.workflowWakeups.values())
      .filter(
        (wakeup) =>
          wakeup.availableAt <= now &&
          (wakeup.leaseExpiresAt === null || wakeup.leaseExpiresAt <= now),
      )
      .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime())[0];
    if (candidate === undefined) return undefined;
    const claimed = { ...candidate, leaseExpiresAt: new Date(now.getTime() + leaseMs) };
    this.workflowWakeups.set(candidate.triggerRunId, claimed);
    return claimed;
  }

  async wakeWorkflowRun(triggerRunId: string, availableAt: Date) {
    const current = this.workflowWakeups.get(triggerRunId);
    this.workflowWakeups.set(triggerRunId, {
      triggerRunId,
      availableAt:
        current === undefined || current.availableAt > availableAt
          ? availableAt
          : current.availableAt,
      leaseExpiresAt: null,
    });
  }

  async deleteWorkflowWakeup(triggerRunId: string) {
    this.workflowWakeups.delete(triggerRunId);
  }

  async createWorkflowStepExecution(input: WorkflowStepExecutionInput) {
    let step = (await this.listWorkflowStepRunsForTriggerRun(input.triggerRunId)).find(
      (candidate) => candidate.stepId === input.stepId && candidate.ordinal === input.ordinal,
    );
    if (step === undefined) {
      throw new Error("workflow step run not found");
    }
    if (step.agentExecutionId !== null) {
      return {
        stepRun: step,
        execution: await this.findAgentExecutionById(step.agentExecutionId),
        created: false,
      };
    }
    const run = this.triggerRuns.get(input.triggerRunId);
    const startedAt = input.execution.startedAt;
    if (run === undefined || run.outcome !== "accepted" || run.status !== "running") {
      return { stepRun: step, execution: undefined, created: false };
    }
    if (run.deadlineAt <= startedAt) {
      this.timeoutWorkflowRun(run.id, startedAt);
      return {
        stepRun: this.workflowStepRuns.get(step.id) ?? step,
        execution: undefined,
        created: false,
      };
    }
    const deadlineAt = new Date(
      Math.min(input.execution.deadlineAt.getTime(), run.deadlineAt.getTime()),
    );
    const idleDeadlineAt = new Date(
      Math.min(input.execution.idleDeadlineAt.getTime(), deadlineAt.getTime()),
    );
    const execution = await this.insertAgentExecution({
      ...input.execution,
      id: input.executionId,
      startedAt,
      deadlineAt,
      idleDeadlineAt,
      workflowStepRunId: step.id,
    });
    step = {
      ...step,
      status: "running",
      agentExecutionId: execution.id,
      deadlineAt: execution.deadlineAt,
      idleDeadlineAt: execution.idleDeadlineAt,
      dispatchIntent: input.execution.launchIntent ?? step.dispatchIntent,
      startedAt: execution.startedAt,
    };
    this.workflowStepRuns.set(step.id, step);
    return { stepRun: step, execution, created: true };
  }

  async linkWorkflowStepRunExecution(
    stepRunId: string,
    executionId: string,
    dispatchIntent?: LaunchMachineIntent,
  ) {
    const step = this.workflowStepRuns.get(stepRunId);
    if (step === undefined) throw new Error(`workflow step run not found: ${stepRunId}`);
    if (step.agentExecutionId !== null && step.agentExecutionId !== executionId) {
      throw new Error(`workflow step run already linked: ${stepRunId}`);
    }
    if (step.agentExecutionId === executionId) return step;
    const execution = await this.findAgentExecutionById(executionId);
    if (execution === undefined) throw new Error(`agent execution not found: ${executionId}`);
    const updated = {
      ...step,
      status:
        step.status === "succeeded" || step.status === "failed" || step.status === "timed_out"
          ? step.status
          : ("running" as const),
      agentExecutionId: executionId,
      startedAt: step.startedAt ?? execution.startedAt,
      ...(dispatchIntent === undefined ? {} : { dispatchIntent }),
    };
    this.workflowStepRuns.set(stepRunId, updated);
    return updated;
  }

  async completeWorkflowStep(
    executionId: string,
    status: "succeeded" | "failed" | "timed_out",
    result: unknown,
    failureReason?: string,
  ) {
    const execution = await this.findAgentExecutionById(executionId);
    if (execution === undefined || execution.workflowStepRunId === null) return undefined;
    await this.completeWorkflowAgentExecution({
      executionId,
      executionStatus: execution.status === "succeeded" ? "succeeded" : "failed",
      stepStatus: status,
      result,
      stepOutput: result,
      ...(failureReason === undefined ? {} : { failureReason }),
    });
    const step = this.workflowStepRuns.get(execution.workflowStepRunId);
    return step === undefined
      ? undefined
      : { stepRun: step, run: this.triggerRuns.get(step.triggerRunId)! };
  }

  async completeWorkflowAgentExecution(input: WorkflowAgentCompletionInput) {
    const execution = this.readAgentExecution(input.executionId);
    if (execution.workflowStepRunId === null) {
      return this.transitionAgentExecution(execution.id, input.executionStatus, {
        result: input.result,
        ...(input.completedByAgent === undefined
          ? {}
          : { completedByAgent: input.completedByAgent }),
        ...(input.deadlineCondition === undefined
          ? {}
          : { deadlineCondition: input.deadlineCondition }),
        ...(input.hubAction === undefined ? {} : { hubAction: input.hubAction }),
      });
    }
    const step = this.workflowStepRuns.get(execution.workflowStepRunId);
    if (step === undefined)
      throw new Error(`workflow step run not found: ${execution.workflowStepRunId}`);
    const run = this.triggerRuns.get(step.triggerRunId);
    if (run === undefined) throw new Error(`workflow trigger run not found: ${step.triggerRunId}`);
    if (run.outcome !== "accepted") throw new Error("rejected trigger run has no workflow step");

    const observedAt = input.observedAt ?? this.now();
    if (execution.status === "spawning" || execution.status === "running") {
      const deadlineKind = workflowDeadlineKind(execution, step, run, observedAt);
      if (deadlineKind === "whole_run") {
        this.timeoutWorkflowRun(run.id, observedAt);
        return {
          execution: this.readAgentExecution(execution.id),
          transitioned: true,
          deadlineKind,
        };
      }
      if (deadlineKind !== undefined) {
        return this.timeoutWorkflowStep(execution.id, deadlineKind, observedAt);
      }
    }

    const transitioned =
      execution.status === "spawning" || execution.status === "running"
        ? await this.transitionAgentExecution(execution.id, input.executionStatus, {
            result: input.result,
            ...(input.completedByAgent === undefined
              ? {}
              : { completedByAgent: input.completedByAgent }),
            ...(input.deadlineCondition === undefined
              ? {}
              : { deadlineCondition: input.deadlineCondition }),
            ...(input.hubAction === undefined ? {} : { hubAction: input.hubAction }),
          })
        : { execution, transitioned: false };
    if (transitioned.transitioned || isTerminalAgentExecutionStatus(execution.status)) {
      this.finishWorkflowStep(step, run, input);
    }
    return transitioned;
  }

  private finishWorkflowStep(
    step: WorkflowStepRunRecord,
    run: TriggerRunRecord,
    input: WorkflowAgentCompletionInput,
  ): void {
    if (step.status === "succeeded" || step.status === "failed" || step.status === "timed_out") {
      return;
    }
    if (run.outcome !== "accepted") throw new Error("rejected trigger run has no workflow step");
    const now = this.options.now?.() ?? new Date();
    const updatedStep: WorkflowStepRunRecord = {
      ...step,
      status: input.stepStatus,
      output: freezeEvidence(input.stepOutput !== undefined ? input.stepOutput : input.result),
      failureReason: input.failureReason ?? null,
      deadlineKind: input.deadlineKind ?? step.deadlineKind,
      completedAt: now,
    };
    this.workflowStepRuns.set(step.id, updatedStep);
    if (input.stepStatus === "succeeded") {
      if (run.status === "running") {
        this.workflowWakeups.set(run.id, {
          triggerRunId: run.id,
          availableAt: now,
          leaseExpiresAt: null,
        });
      }
      return;
    }
    if (run.status === "running") {
      let runStatus: TriggerRunRecord["status"] = input.stepStatus;
      if (input.deadlineKind === "whole_run") {
        runStatus = "timed_out";
      } else if (input.deadlineKind !== undefined) {
        runStatus = "failed";
      }
      this.triggerRuns.set(run.id, {
        ...run,
        status: runStatus,
        deadlineKind: input.deadlineKind ?? run.deadlineKind,
        failureReason: input.failureReason ?? null,
        completedAt: now,
      });
    }
    this.workflowWakeups.delete(run.id);
  }

  private timeoutWorkflowStep(
    executionId: string,
    deadlineKind: Exclude<WorkflowDeadlineKind, "whole_run">,
    now: Date,
  ): TransitionAgentExecutionResult {
    const execution = this.readAgentExecution(executionId);
    if (isTerminalAgentExecutionStatus(execution.status)) {
      return { execution, transitioned: false };
    }
    const failureReason = deadlineKind === "step_idle" ? "step_idle_timeout" : "step_hard_timeout";
    let hubAction: "interrupt" | "archive" | null = null;
    if (execution.daemonId !== null) {
      hubAction = execution.launchIntent?.autoArchive === true ? "archive" : "interrupt";
    }
    const updatedExecution: AgentExecutionRecord = {
      ...execution,
      status: "failed",
      completedAt: now,
      result: { status: "failed", reason: failureReason },
      idleDeadlineAt: null,
      hubAction,
      hubActionCompletedAt: hubAction === null ? null : null,
    };
    this.agentExecutions.set(execution.id, updatedExecution);
    const step =
      execution.workflowStepRunId === null
        ? undefined
        : this.workflowStepRuns.get(execution.workflowStepRunId);
    if (
      step === undefined ||
      step.status === "succeeded" ||
      step.status === "failed" ||
      step.status === "timed_out"
    ) {
      return { execution: updatedExecution, transitioned: true, deadlineKind };
    }
    const run = this.triggerRuns.get(step.triggerRunId);
    if (run === undefined || run.outcome !== "accepted") {
      return { execution: updatedExecution, transitioned: true, deadlineKind };
    }
    this.workflowStepRuns.set(step.id, {
      ...step,
      status: "timed_out",
      failureReason,
      deadlineKind,
      completedAt: now,
    });
    if (run.status === "running") {
      this.triggerRuns.set(run.id, {
        ...run,
        status: "failed",
        deadlineKind,
        failureReason,
        completedAt: now,
      });
    }
    this.workflowWakeups.delete(run.id);
    return { execution: updatedExecution, transitioned: true, deadlineKind };
  }

  private timeoutWorkflowRun(
    triggerRunId: string,
    now: Date,
  ): WorkflowDeadlineRecovery | undefined {
    const run = this.triggerRuns.get(triggerRunId);
    if (run === undefined || run.outcome !== "accepted" || run.status !== "running") {
      return undefined;
    }
    const executionIds: string[] = [];
    for (const step of this.workflowStepRuns.values()) {
      if (step.triggerRunId !== triggerRunId) continue;
      if (step.agentExecutionId !== null) {
        const execution = this.agentExecutions.get(step.agentExecutionId);
        if (
          execution !== undefined &&
          (execution.status === "spawning" || execution.status === "running")
        ) {
          const updatedExecution: AgentExecutionRecord = {
            ...execution,
            status: "failed",
            completedAt: now,
            result: { status: "failed", reason: "whole_run_timeout" },
            idleDeadlineAt: null,
            hubAction: execution.daemonId === null ? null : "interrupt",
            hubActionCompletedAt: null,
          };
          this.agentExecutions.set(execution.id, updatedExecution);
          executionIds.push(execution.id);
        }
      }
      if (step.status === "pending" || step.status === "running") {
        this.workflowStepRuns.set(step.id, {
          ...step,
          status: "timed_out",
          failureReason: "whole_run_timeout",
          deadlineKind: "whole_run",
          completedAt: now,
        });
      }
    }
    const updatedRun: AcceptedTriggerRunRecord = {
      ...run,
      status: "timed_out",
      deadlineKind: "whole_run",
      failureReason: "whole_run_timeout",
      completedAt: now,
    };
    this.triggerRuns.set(run.id, updatedRun);
    this.workflowWakeups.delete(run.id);
    return { triggerRunId: run.id, executionIds };
  }

  async recoverWorkflowDeadlines(now: Date): Promise<readonly WorkflowDeadlineRecovery[]> {
    const recoveries: WorkflowDeadlineRecovery[] = [];
    for (const run of this.triggerRuns.values()) {
      if (run.outcome !== "accepted" || run.status !== "running") continue;
      if (run.deadlineAt <= now) {
        const recovery = this.timeoutWorkflowRun(run.id, now);
        if (recovery !== undefined) recoveries.push(recovery);
        continue;
      }
      const steps = await this.listWorkflowStepRunsForTriggerRun(run.id);
      for (const step of steps) {
        if (step.status !== "running") continue;
        const execution =
          step.agentExecutionId === null
            ? undefined
            : this.agentExecutions.get(step.agentExecutionId);
        if (execution !== undefined && isTerminalAgentExecutionStatus(execution.status)) continue;
        const deadlineKind = workflowDeadlineKind(execution, step, run, now);
        if (deadlineKind === undefined || deadlineKind === "whole_run") continue;
        if (execution !== undefined) {
          const recovery = this.timeoutWorkflowStep(execution.id, deadlineKind, now);
          recoveries.push({ triggerRunId: run.id, executionIds: [recovery.execution.id] });
        } else {
          this.workflowStepRuns.set(step.id, {
            ...step,
            status: "timed_out",
            failureReason: deadlineKind === "step_idle" ? "step_idle_timeout" : "step_hard_timeout",
            deadlineKind,
            completedAt: now,
          });
          this.triggerRuns.set(run.id, {
            ...run,
            status: "failed",
            deadlineKind,
            failureReason: deadlineKind === "step_idle" ? "step_idle_timeout" : "step_hard_timeout",
            completedAt: now,
          });
          this.workflowWakeups.delete(run.id);
          recoveries.push({ triggerRunId: run.id, executionIds: [] });
        }
      }
    }
    return recoveries;
  }

  async markWorkflowStepSkipped(triggerRunId: string, stepId: string, reason: string) {
    const run = this.triggerRuns.get(triggerRunId);
    const step = (await this.listWorkflowStepRunsForTriggerRun(triggerRunId)).find(
      (candidate) => candidate.stepId === stepId,
    );
    if (run === undefined || step === undefined || run.outcome !== "accepted") return undefined;
    if (step.status !== "pending") return { stepRun: step, run };
    const now = this.options.now?.() ?? new Date();
    const updatedStep = {
      ...step,
      status: "skipped" as const,
      failureReason: reason,
      completedAt: now,
    };
    this.workflowStepRuns.set(step.id, updatedStep);
    this.workflowWakeups.set(run.id, {
      triggerRunId: run.id,
      availableAt: now,
      leaseExpiresAt: null,
    });
    return { stepRun: updatedStep, run };
  }

  async succeedTriggerRun(triggerRunId: string) {
    const run = this.triggerRuns.get(triggerRunId);
    if (run === undefined || run.outcome !== "accepted") return undefined;
    if (run.status !== "running") return run;
    const now = this.options.now?.() ?? new Date();
    const updated = { ...run, status: "succeeded" as const, completedAt: now };
    this.triggerRuns.set(run.id, updated);
    this.workflowWakeups.delete(run.id);
    return updated;
  }

  async failWorkflowRun(
    triggerRunId: string,
    status: "failed" | "timed_out",
    failureReason: string,
    stepId?: string,
  ) {
    const run = this.triggerRuns.get(triggerRunId);
    const steps = await this.listWorkflowStepRunsForTriggerRun(triggerRunId);
    const step =
      (stepId === undefined
        ? steps.find(
            (candidate) => candidate.status === "pending" || candidate.status === "running",
          )
        : steps.find((candidate) => candidate.stepId === stepId)) ?? steps[0];
    if (run === undefined || step === undefined) return undefined;
    if (run.status !== "running") return { stepRun: step, run };
    const now = this.options.now?.() ?? new Date();
    const updatedStep =
      step.status === "pending" || step.status === "running"
        ? { ...step, status, failureReason, completedAt: now }
        : step;
    if (run.outcome !== "accepted") throw new Error("rejected trigger run has no workflow step");
    const updatedRun: AcceptedTriggerRunRecord = {
      ...run,
      status,
      failureReason,
      completedAt: now,
    };
    this.workflowStepRuns.set(step.id, updatedStep);
    this.triggerRuns.set(run.id, updatedRun);
    this.workflowWakeups.delete(run.id);
    return { stepRun: updatedStep, run: updatedRun };
  }

  async recoverWorkflowWakeups(now: Date) {
    for (const run of this.triggerRuns.values()) {
      if (run.status !== "running" || run.deadlineAt <= now) continue;
      const wakeup = this.workflowWakeups.get(run.id);
      const steps = await this.listWorkflowStepRunsForTriggerRun(run.id);
      const execution = (
        await Promise.all(
          steps.map(async (step) =>
            step.agentExecutionId === null
              ? undefined
              : this.findAgentExecutionById(step.agentExecutionId),
          ),
        )
      ).find(
        (candidate) =>
          candidate !== undefined &&
          (candidate.status === "spawning" || candidate.status === "running"),
      );
      if (wakeup === undefined && execution === undefined) {
        this.workflowWakeups.set(run.id, {
          triggerRunId: run.id,
          availableAt: now,
          leaseExpiresAt: null,
        });
      }
    }
  }

  async insertTrigger(input: InsertTriggerInput): Promise<InsertTriggerResult> {
    let existingId: string | undefined;
    if (input.receiptId === undefined) {
      existingId =
        input.signatureHash === null || input.signatureHash === undefined
          ? this.triggersByDeliveryId.get(
              triggerDeliveryKey(input.organizationId, input.deliveryId),
            )
          : (this.triggersBySignatureHash.get(input.signatureHash) ??
            this.triggersByDeliveryId.get(
              triggerDeliveryKey(input.organizationId, input.deliveryId),
            ));
    }

    if (existingId !== undefined) {
      const existing = this.triggers.get(existingId);

      if (existing === undefined) {
        throw new Error(`trigger index points at missing row: ${existingId}`);
      }

      return {
        inserted: false,
        trigger: existing,
      };
    }

    const trigger: TriggerRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      configurationRevisionId: input.configurationRevisionId ?? null,
      receiptId: input.receiptId ?? this.receiptIdFor(input),
      connectionId: input.connectionId ?? null,
      resourceId: input.resourceId ?? null,
      deliveryId: input.deliveryId,
      signatureHash: input.signatureHash ?? null,
      source: input.source,
      repo: input.repo ?? null,
      payload: input.payload,
      receivedAt: input.receivedAt,
      matchedTriggerName: input.matchedTriggerName ?? null,
      configuredTriggerNames: [],
      droppedReason: input.droppedReason ?? null,
    };

    this.triggers.set(trigger.id, trigger);
    this.triggersByDeliveryId.set(
      triggerDeliveryKey(trigger.organizationId, trigger.deliveryId),
      trigger.id,
    );
    const receiptTriggers = this.triggerIdsByReceipt.get(trigger.receiptId) ?? [];
    receiptTriggers.push(trigger.id);
    this.triggerIdsByReceipt.set(trigger.receiptId, receiptTriggers);
    if (trigger.signatureHash !== null) {
      this.triggersBySignatureHash.set(trigger.signatureHash, trigger.id);
    }

    return {
      inserted: true,
      trigger,
    };
  }

  private receiptIdFor(input: InsertTriggerInput): string {
    const existing = this.receiptIdsByDelivery.get(
      triggerDeliveryKey(input.organizationId, input.deliveryId),
    );
    if (existing !== undefined) return existing;
    const id = randomUUID();
    this.receiptIdsByDelivery.set(triggerDeliveryKey(input.organizationId, input.deliveryId), id);
    return id;
  }

  async markTriggerDropped(id: string, reason: string): Promise<TriggerRecord> {
    const trigger = this.readTrigger(id);
    const updated = {
      ...trigger,
      droppedReason: trigger.droppedReason ?? reason,
    };
    this.triggers.set(id, updated);
    return updated;
  }

  async acceptGitHubTrigger(input: AcceptGitHubTriggerInput): Promise<ProviderTriggerAcceptance> {
    const binding = await this.findGitHubConnection(input.installationId);
    const reason = githubDropReason(input, binding);
    return this.acceptMemoryTrigger(
      input,
      binding?.organizationId,
      binding?.id,
      input.repositoryId === undefined ? null : String(input.repositoryId),
      reason,
    );
  }

  async acceptDiscordTrigger(input: AcceptDiscordTriggerInput): Promise<ProviderTriggerAcceptance> {
    const binding = await this.findDiscordConnection(input.guildId);
    const reason = discordDropReason(input, binding);
    return this.acceptMemoryTrigger(
      input,
      binding?.organizationId,
      binding?.id,
      input.guildId,
      reason,
    );
  }

  async acceptSlackTrigger(input: AcceptSlackTriggerInput): Promise<ProviderTriggerAcceptance> {
    const binding = await this.findSlackConnection(input.teamId);
    const reason = slackDropReason(input, binding);
    return this.acceptMemoryTrigger(
      input,
      binding?.organizationId,
      binding?.id,
      input.teamId,
      reason,
    );
  }

  async persistManualTrigger(input: PersistManualTriggerInput) {
    const result = await this.insertTrigger(input);
    return result.inserted
      ? { status: "accepted" as const, trigger: durableTrigger(result.trigger) }
      : { status: "duplicate" as const, triggerId: result.trigger.id };
  }

  async claimGitHubLifecycle(input: GitHubLifecycleClaimInput): Promise<GitHubLifecycleClaim> {
    const result = await this.insertTrigger({
      organizationId: "unbound",
      projectId: null,
      deliveryId: input.deliveryId,
      signatureHash: input.signatureHash,
      source: input.source,
      payload: input.payload,
      receivedAt: input.receivedAt,
      droppedReason: "github_lifecycle",
    });
    return result.inserted
      ? {
          status: "claimed",
          triggerId: result.trigger.id,
          installationId: input.installationId,
        }
      : { status: "duplicate", triggerId: result.trigger.id };
  }

  async applyGitHubLifecycle(
    claim: Extract<GitHubLifecycleClaim, { status: "claimed" }>,
    result: GitHubLifecycleResult,
  ): Promise<void> {
    const evidence = this.triggers.get(claim.triggerId);
    if (evidence?.droppedReason !== "github_lifecycle") return;
    if (result.status !== "absent" || !result.removeBinding) return;
    const connection = this.githubConnections.get(claim.installationId);
    if (connection === undefined) return;
    this.githubConnections.delete(claim.installationId);
    for (const [projectId, source] of this.githubConfigurationSources) {
      if (source.githubConnectionId !== connection.id) continue;
      this.configurationAuthorities.set(projectId, "manual");
      this.githubConfigurationSources.delete(projectId);
    }
    for (const [projectId, attempts] of this.configurationSyncAttempts) {
      this.configurationSyncAttempts.set(
        projectId,
        attempts.map((attempt) =>
          attempt.githubConnectionId === connection.id
            ? Object.assign({}, attempt, { githubConnectionId: null })
            : attempt,
        ),
      );
    }
    for (const [projectId, routes] of this.projectTriggerRoutes) {
      this.projectTriggerRoutes.set(
        projectId,
        routes.filter((route) => route.connectionId !== connection.id),
      );
    }
  }

  releaseGitHubLifecycleClaim(triggerId: string): Promise<void> {
    return this.deleteLifecycleClaim(triggerId);
  }

  async findTriggerByDeliveryId(
    deliveryId: string,
    organizationId?: string,
  ): Promise<TriggerRecord | undefined> {
    const id = this.triggersByDeliveryId.get(
      organizationId === undefined ? deliveryId : `${organizationId}:${deliveryId}`,
    );
    const trigger = id === undefined ? undefined : this.triggers.get(id);
    return trigger === undefined ? undefined : this.triggerWithConfiguredNames(trigger);
  }

  async findTriggerById(id: string): Promise<TriggerRecord | undefined> {
    const trigger = this.triggers.get(id);
    return trigger === undefined ? undefined : this.triggerWithConfiguredNames(trigger);
  }

  async insertMachine(input: InsertMachineInput): Promise<MachineRecord> {
    this.organizationIds.add(input.orgId);
    const machine: MachineRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      source: input.source,
      status: input.status ?? "spawning",
      startedAt: new Date(),
      terminatedAt: null,
      shutdownReason: null,
      triggerName: input.triggerName ?? null,
      triggerContext: input.triggerContext ?? null,
      specs: input.specs ?? null,
    };

    this.machines.set(machine.id, machine);
    return machine;
  }

  async findMachineById(id: string): Promise<MachineRecord | undefined> {
    return this.machines.get(id);
  }

  async findMachineForOrganization(
    organizationId: string,
    id: string,
  ): Promise<MachineRecord | undefined> {
    const machine = this.machines.get(id);
    return machine?.orgId === organizationId ? machine : undefined;
  }

  async transitionMachine(
    id: string,
    toStatus: MachineStatus,
    fields?: TerminateMachineFields,
  ): Promise<MachineRecord> {
    const machine = this.readMachine(id);
    const updated: MachineRecord = {
      ...machine,
      status: toStatus,
      terminatedAt: toStatus === "terminated" ? new Date() : machine.terminatedAt,
      shutdownReason: fields?.reason ?? machine.shutdownReason,
    };

    this.machines.set(id, updated);
    return updated;
  }

  async insertAgentExecution(input: InsertAgentExecutionInput): Promise<AgentExecutionRecord> {
    if (input.machineId !== null && !this.machines.has(input.machineId)) {
      throw new Error(`machine not found: ${input.machineId}`);
    }

    const status = input.status ?? "spawning";
    const completedAt = status === "failed" ? this.now() : null;
    const deadlineAt = input.deadlineAt ?? null;
    const idleDeadlineAt = capIdleDeadline(input.idleDeadlineAt, deadlineAt);

    const execution: AgentExecutionRecord = {
      id: input.id ?? randomUUID(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      machineId: input.machineId,
      status,
      startedAt: input.startedAt ?? this.now(),
      completedAt,
      completedByAgentAt: null,
      deadlineAt,
      idleDeadlineAt,
      result: input.result ?? null,
      triggerContext: input.triggerContext,
      outputContext: input.outputContext,
      configurationRevisionId: input.configurationRevisionId,
      completionTokenHash: input.completionTokenHash ?? null,
      replyClaimedAt: null,
      replyClaimCount: 0,
      launchIntent: input.launchIntent ?? null,
      daemonId: input.daemonId ?? null,
      daemonAgentId: null,
      triggerId: input.triggerId ?? null,
      triggerConnectionId: input.triggerConnectionId ?? null,
      triggerResourceId: input.triggerResourceId ?? null,
      workflowStepRunId: input.workflowStepRunId ?? null,
      hubAction: null,
      hubActionCompletedAt: null,
    };

    this.agentExecutions.set(execution.id, execution);
    this.options.onInsertAgentExecution?.(execution);
    return execution;
  }

  async insertAgentExecutionIfAbsent(
    input: InsertAgentExecutionInput & { id: string },
  ): Promise<AgentExecutionRecord | undefined> {
    if (this.agentExecutions.has(input.id)) return undefined;
    return this.insertAgentExecution(input);
  }

  async issueEnrollmentToken(input: EnrollmentTokenRecord): Promise<boolean> {
    this.enrollmentTokens.set(input.verifier, input);
    return true;
  }
  async startDeviceAuthorization(
    input: StartDeviceAuthorizationInput,
  ): Promise<DeviceAuthorizationRecord | undefined> {
    const now = this.options.now?.() ?? new Date();
    const active = Array.from(this.deviceAuthorizations.values()).filter(
      (authorization) =>
        (authorization.status === "pending" || authorization.status === "approved") &&
        authorization.expiresAt > now,
    );
    const fingerprintCount = active.filter(
      (authorization) => authorization.fingerprintVerifier === input.fingerprintVerifier,
    ).length;
    if (fingerprintCount >= input.perFingerprintLimit || active.length >= input.globalLimit) {
      return undefined;
    }
    const authorization: MemoryDeviceAuthorization = {
      id: input.id,
      deviceVerifier: input.deviceVerifier,
      userCodeVerifier: input.userCodeVerifier,
      fingerprintVerifier: input.fingerprintVerifier,
      suggestedDisplayName: input.suggestedDisplayName,
      status: "pending",
      pollIntervalSeconds: input.pollIntervalSeconds,
      nextPollAt: now,
      approvedOrganizationId: null,
      approvedByUserId: null,
      approvedDisplayName: null,
      enrollmentTokenVerifier: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + input.lifetimeSeconds * 1_000),
    };
    this.deviceAuthorizations.set(input.deviceVerifier, authorization);
    return authorization;
  }
  async inspectDeviceAuthorization(userCodeVerifier: string) {
    const now = this.options.now?.() ?? new Date();
    const authorization = Array.from(this.deviceAuthorizations.values()).find(
      (candidate) => candidate.userCodeVerifier === userCodeVerifier,
    );
    if (authorization !== undefined && authorization.expiresAt <= now) {
      authorization.status = "expired";
    }
    if (authorization === undefined || authorization.status !== "pending") {
      return undefined;
    }
    return authorization;
  }
  async decideDeviceAuthorization(
    input: DeviceAuthorizationDecisionInput,
  ): Promise<"approved" | "denied" | "unavailable" | "forbidden"> {
    const now = this.options.now?.() ?? new Date();
    const authorization = Array.from(this.deviceAuthorizations.values()).find(
      (candidate) => candidate.userCodeVerifier === input.userCodeVerifier,
    );
    if (authorization !== undefined && authorization.expiresAt <= now) {
      authorization.status = "expired";
    }
    if (authorization === undefined || authorization.status !== "pending") {
      return "unavailable";
    }
    const status = input.decision === "approve" ? "approved" : "denied";
    authorization.status = status;
    if (input.decision === "approve") {
      authorization.approvedOrganizationId = input.access.organizationId;
      authorization.approvedByUserId = input.access.userId;
      authorization.approvedDisplayName = input.displayName;
    }
    return status;
  }
  async pollDeviceAuthorization(input: {
    deviceVerifier: string;
    enrollmentTokenVerifier: string;
  }): Promise<DevicePollResult> {
    const now = this.options.now?.() ?? new Date();
    const authorization = this.deviceAuthorizations.get(input.deviceVerifier);
    if (authorization !== undefined && authorization.expiresAt <= now) {
      authorization.status = "expired";
    }
    if (authorization === undefined || authorization.status === "expired") {
      return {
        status: "expired",
        intervalSeconds: authorization?.pollIntervalSeconds ?? 5,
      };
    }
    if (authorization.status === "denied" || authorization.status === "enrolled") {
      return {
        status: authorization.status,
        intervalSeconds: authorization.pollIntervalSeconds,
      };
    }
    if (authorization.nextPollAt > now) {
      authorization.pollIntervalSeconds += 5;
      authorization.nextPollAt = new Date(
        now.getTime() + authorization.pollIntervalSeconds * 1_000,
      );
      return {
        status: "slow_down",
        intervalSeconds: authorization.pollIntervalSeconds,
      };
    }
    authorization.nextPollAt = new Date(now.getTime() + authorization.pollIntervalSeconds * 1_000);
    if (authorization.status === "approved") {
      authorization.enrollmentTokenVerifier = input.enrollmentTokenVerifier;
      this.enrollmentTokens.set(input.enrollmentTokenVerifier, {
        id: randomUUID(),
        verifier: input.enrollmentTokenVerifier,
        organizationId: authorization.approvedOrganizationId!,
        authorizationId: authorization.id,
        displayName: authorization.approvedDisplayName,
        approvedByUserId: authorization.approvedByUserId,
        issuedByApiKeyId: null,
        registrationMethod: "device",
        expiresAt: authorization.expiresAt,
        consumedAt: null,
      });
    }
    return {
      status: authorization.status,
      intervalSeconds: authorization.pollIntervalSeconds,
    };
  }
  async enrollDaemon(input: EnrollDaemonInput): Promise<DaemonRecord | undefined> {
    const replay = Array.from(this.daemons.values()).find((daemon) => daemon.id === input.daemonId);
    if (replay) return replay;
    const token = this.enrollmentTokens.get(input.tokenVerifier);
    if (!token || token.consumedAt || token.expiresAt <= input.now) return undefined;
    this.enrollmentTokens.set(input.tokenVerifier, {
      ...token,
      consumedAt: input.now,
    });
    const machine = await this.insertMachine({
      orgId: token.organizationId,
      source: { kind: "daemon", daemonId: input.daemonId },
      status: "alive",
    });
    const daemon: DaemonRecord = {
      id: input.daemonId,
      slug: `daemon-${input.daemonId.slice(0, 8)}`,
      machineId: machine.id,
      serverId: input.serverId,
      daemonPublicKey: input.daemonPublicKey,
      credentialVerifier: input.credentialVerifier,
      scopes: input.scopes,
      displayName: token.displayName ?? `daemon-${input.daemonId.slice(0, 8)}`,
      approvedByUserId: token.approvedByUserId ?? null,
      registeredByApiKeyId: token.issuedByApiKeyId ?? null,
      registrationMethod: token.registrationMethod ?? "operator",
      status: "active",
      presence: "offline",
      connectedAt: null,
      disconnectedAt: null,
      lastSeenAt: input.now,
      createdAt: input.now,
    };
    this.daemons.set(daemon.id, daemon);
    if (token.authorizationId !== null && token.authorizationId !== undefined) {
      const authorization = Array.from(this.deviceAuthorizations.values()).find(
        (candidate) => candidate.id === token.authorizationId,
      );
      if (authorization !== undefined) authorization.status = "enrolled";
    }
    return daemon;
  }
  async findDaemonBySlugForOrganization(organizationId: string, slug: string) {
    return Array.from(this.daemons.values()).find(
      (daemon) =>
        daemon.slug === slug && this.machines.get(daemon.machineId)?.orgId === organizationId,
    );
  }
  async findDaemonById(id: string) {
    return this.daemons.get(id);
  }
  async findDaemonForOrganization(organizationId: string, id: string) {
    const daemon = this.daemons.get(id);
    const machine = daemon === undefined ? undefined : this.machines.get(daemon.machineId);
    return machine?.orgId === organizationId ? daemon : undefined;
  }
  async listDaemonsForOrganization(organizationId: string) {
    return Array.from(this.daemons.values())
      .filter((daemon) => this.machines.get(daemon.machineId)?.orgId === organizationId)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }
  async renameDaemonForOrganization(organizationId: string, id: string, displayName: string) {
    const daemon = await this.findDaemonForOrganization(organizationId, id);
    if (daemon === undefined) return undefined;
    const renamed = { ...daemon, displayName };
    this.daemons.set(id, renamed);
    return renamed;
  }
  async touchDaemon(id: string) {
    const value = this.daemons.get(id);
    if (value) this.daemons.set(id, { ...value, lastSeenAt: new Date() });
  }
  async setDaemonPresence(id: string, presence: "offline" | "connected") {
    const value = this.daemons.get(id);
    if (!value) return;
    this.daemons.set(id, {
      ...value,
      presence,
      connectedAt: presence === "connected" ? new Date() : value.connectedAt,
      disconnectedAt: presence === "offline" ? new Date() : value.disconnectedAt,
    });
  }
  async revokeDaemon(id: string) {
    const value = this.daemons.get(id);
    if (!value || value.status === "revoked") return false;
    this.daemons.set(id, { ...value, status: "revoked" });
    return true;
  }
  async attachAgentToExecution(executionId: string, daemonId: string, agentId: string) {
    const value = this.readAgentExecution(executionId);
    const updated = { ...value, daemonId: daemonId, daemonAgentId: agentId };
    this.agentExecutions.set(executionId, updated);
    return updated;
  }

  async setAgentExecutionIdleDeadline(
    executionId: string,
    idleDeadlineAt: Date | null,
    observedAt: Date,
  ) {
    const execution = this.readAgentExecution(executionId);
    if (isTerminalAgentExecutionStatus(execution.status)) return execution;
    if (execution.deadlineAt !== null && execution.deadlineAt.getTime() <= observedAt.getTime()) {
      return execution;
    }
    const boundedIdleDeadlineAt = capIdleDeadline(idleDeadlineAt, execution.deadlineAt);
    const updated = { ...execution, idleDeadlineAt: boundedIdleDeadlineAt };
    this.agentExecutions.set(executionId, updated);
    if (execution.workflowStepRunId !== null) {
      const step = this.workflowStepRuns.get(execution.workflowStepRunId);
      if (step !== undefined) {
        this.workflowStepRuns.set(step.id, { ...step, idleDeadlineAt: boundedIdleDeadlineAt });
      }
    }
    return updated;
  }

  async prepareAgentExecutionForDispatch(
    executionId: string,
    daemonId: string,
    machineId: string,
    completionTokenHash: string,
  ) {
    const execution = this.readAgentExecution(executionId);
    if (isTerminalAgentExecutionStatus(execution.status)) return execution;
    const updated = {
      ...execution,
      daemonId,
      machineId,
      completionTokenHash: execution.completionTokenHash ?? completionTokenHash,
    };
    this.agentExecutions.set(executionId, updated);
    return updated;
  }

  async findAgentExecutionById(id: string): Promise<AgentExecutionRecord | undefined> {
    return this.agentExecutions.get(id);
  }
  async findAgentExecutionForOrganization(
    organizationId: string,
    id: string,
  ): Promise<AgentExecutionRecord | undefined> {
    const execution = this.agentExecutions.get(id);
    if (execution === undefined) return undefined;
    const machine =
      execution.machineId === null ? undefined : this.machines.get(execution.machineId);
    const trigger =
      execution.triggerId === null ? undefined : this.triggers.get(execution.triggerId);
    return machine?.orgId === organizationId || trigger?.organizationId === organizationId
      ? execution
      : undefined;
  }
  async findAgentExecutionForProject(projectId: string, id: string) {
    const execution = this.agentExecutions.get(id);
    return execution?.projectId === projectId ? execution : undefined;
  }
  async findAgentExecutionByTriggerId(
    triggerId: string,
  ): Promise<AgentExecutionRecord | undefined> {
    return Array.from(this.agentExecutions.values()).find(
      (execution) => execution.triggerId === triggerId,
    );
  }
  async findAgentExecutionsByTriggerId(triggerId: string): Promise<AgentExecutionRecord[]> {
    return Array.from(this.agentExecutions.values()).filter(
      (execution) => execution.triggerId === triggerId,
    );
  }

  async listAgentExecutionsForProject(projectId: string, limit: number) {
    return Array.from(this.agentExecutions.values())
      .filter((execution) => execution.projectId === projectId)
      .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
      .slice(0, limit);
  }

  async listTriggersForProject(projectId: string, limit: number) {
    return Array.from(this.triggers.values())
      .filter((trigger) => trigger.projectId === projectId)
      .sort((left, right) => right.receivedAt.getTime() - left.receivedAt.getTime())
      .slice(0, limit)
      .map((trigger) => this.triggerWithConfiguredNames(trigger));
  }

  private triggerWithConfiguredNames(trigger: TriggerRecord): TriggerRecord {
    const configuredTriggerNames = [...this.triggerRuns.values()]
      .filter((run) => run.triggerId === trigger.id)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((run) => run.configuredTriggerName);
    return { ...trigger, configuredTriggerNames };
  }

  async claimAgentExecutionReply(
    executionId: string,
    maxReplies: number,
    claimedAt: Date,
  ): Promise<boolean> {
    const execution = this.readAgentExecution(executionId);
    if (
      execution.replyClaimCount >= maxReplies ||
      (execution.status !== "spawning" && execution.status !== "running")
    ) {
      return false;
    }
    this.agentExecutions.set(executionId, {
      ...execution,
      replyClaimedAt: execution.replyClaimedAt ?? claimedAt,
      replyClaimCount: execution.replyClaimCount + 1,
    });
    return true;
  }

  async transitionAgentExecution(
    id: string,
    toStatus: AgentExecutionStatus,
    fields: TransitionAgentExecutionFields = {},
  ): Promise<TransitionAgentExecutionResult> {
    const execution = this.readAgentExecution(id);
    if (isTerminalAgentExecutionStatus(execution.status)) {
      return { execution, transitioned: false };
    }
    if (fields.deadlineCondition !== undefined) {
      const current =
        fields.deadlineCondition.kind === "hard" ? execution.deadlineAt : execution.idleDeadlineAt;
      if (
        current?.getTime() !== fields.deadlineCondition.deadlineAt.getTime() ||
        current.getTime() > fields.deadlineCondition.observedAt.getTime()
      ) {
        return { execution, transitioned: false };
      }
    }

    let hubActionCompletedAt = execution.hubActionCompletedAt;
    if (fields.hubAction !== undefined) {
      hubActionCompletedAt = fields.hubAction === null ? this.now() : null;
    }
    const updated: AgentExecutionRecord = {
      ...execution,
      status: toStatus,
      completedAt: isTerminalAgentExecutionStatus(toStatus) ? this.now() : execution.completedAt,
      completedByAgentAt:
        fields.completedByAgent === true && toStatus === "succeeded"
          ? this.now()
          : execution.completedByAgentAt,
      result: fields.result !== undefined ? fields.result : execution.result,
      idleDeadlineAt: isTerminalAgentExecutionStatus(toStatus) ? null : execution.idleDeadlineAt,
      hubAction: fields.hubAction === undefined ? execution.hubAction : fields.hubAction,
      hubActionCompletedAt,
    };

    this.agentExecutions.set(id, updated);
    return { execution: updated, transitioned: true };
  }

  async findRunningAgentExecutionsForMachine(machineId: string): Promise<AgentExecutionRecord[]> {
    return Array.from(this.agentExecutions.values()).filter(
      (execution) =>
        execution.machineId === machineId &&
        (execution.status === "spawning" || execution.status === "running"),
    );
  }

  async findPendingAgentExecutions(): Promise<AgentExecutionRecord[]> {
    return Array.from(this.agentExecutions.values()).filter(
      (execution) => execution.status === "spawning" || execution.status === "running",
    );
  }

  async findPendingHubActions(daemonId?: string): Promise<AgentExecutionRecord[]> {
    return Array.from(this.agentExecutions.values()).filter(
      (execution) =>
        execution.hubAction !== null &&
        execution.hubActionCompletedAt === null &&
        (daemonId === undefined || execution.daemonId === daemonId),
    );
  }

  async completeHubAction(executionId: string, action: "interrupt" | "archive"): Promise<boolean> {
    const execution = this.readAgentExecution(executionId);
    if (execution.hubAction !== action || execution.hubActionCompletedAt !== null) return false;
    this.agentExecutions.set(executionId, {
      ...execution,
      hubActionCompletedAt: new Date(),
    });
    return true;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    if (
      Array.from(this.projects.values()).some(
        (project) => project.organizationId === input.organizationId && project.slug === input.slug,
      )
    ) {
      throw new Error("project slug already exists");
    }
    const now = new Date();
    const project: ProjectRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      slug: input.slug,
      status: "active",
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      activeConfigurationRevisionId: null,
    };
    this.organizationIds.add(input.organizationId);
    this.projects.set(project.id, project);
    this.configurationAuthorities.set(project.id, "manual");
    return project;
  }

  async listProjectsForOrganization(organizationId: string) {
    return Array.from(this.projects.values()).filter(
      (project) => project.organizationId === organizationId,
    );
  }

  async findProjectForOrganization(organizationId: string, projectId: string) {
    const project = this.projects.get(projectId);
    return project?.organizationId === organizationId ? project : undefined;
  }

  async findProjectById(projectId: string) {
    return this.projects.get(projectId);
  }

  async findProjectBySlugForOrganization(organizationId: string, slug: string) {
    return Array.from(this.projects.values()).find(
      (project) => project.organizationId === organizationId && project.slug === slug,
    );
  }

  async resolveTenantRouteAccess(
    userId: string,
    organizationSlug: string,
    projectSlug?: string,
  ): Promise<TenantRouteAccess | undefined> {
    const membership = this.options.memberships?.find(
      (candidate) => candidate.userId === userId && candidate.organizationSlug === organizationSlug,
    );
    if (membership === undefined) return undefined;
    const project =
      projectSlug === undefined
        ? undefined
        : Array.from(this.projects.values()).find(
            (candidate) =>
              candidate.organizationId === membership.organizationId &&
              candidate.slug === projectSlug &&
              candidate.status === "active",
          );
    if (projectSlug !== undefined && project === undefined) return undefined;
    return {
      organization: {
        id: membership.organizationId,
        name: membership.organizationName,
        slug: membership.organizationSlug,
      },
      membership: { id: membership.membershipId, role: membership.role },
      ...(project === undefined ? {} : { project }),
    };
  }

  async archiveProject(organizationId: string, projectId: string, _userId: string) {
    const project = await this.findProjectForOrganization(organizationId, projectId);
    if (project === undefined) throw new Error("project access denied");
    const now = new Date();
    const archived: ProjectRecord = {
      ...project,
      status: "archived",
      archivedAt: now,
      updatedAt: now,
      activeConfigurationRevisionId: null,
    };
    this.projects.set(projectId, archived);
    return archived;
  }

  async updateProjectSlug(
    organizationId: string,
    projectId: string,
    slug: string,
    _userId: string,
  ) {
    const project = await this.findProjectForOrganization(organizationId, projectId);
    if (project === undefined) throw new Error("project access denied");
    const updated = { ...project, slug, updatedAt: new Date() };
    this.projects.set(projectId, updated);
    return updated;
  }

  async insertProjectConfigurationRevision(
    input: InsertProjectConfigurationRevisionInput,
  ): Promise<ProjectConfigurationRevisionRecord> {
    const project = this.projects.get(input.projectId);
    if (project?.status !== "active") throw new Error("project not found");
    const version =
      Math.max(
        0,
        ...Array.from(this.configurationRevisions.values())
          .filter((revision) => revision.projectId === input.projectId)
          .map((revision) => revision.version),
      ) + 1;
    const now = new Date();
    const revision: ProjectConfigurationRevisionRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      organizationId: project.organizationId,
      version,
      sourceKind: input.sourceKind,
      sourceEvidence: input.sourceEvidence,
      rawYaml: input.rawYaml ?? null,
      normalizedConfiguration: input.normalizedConfiguration,
      validationErrors: input.validationErrors ?? null,
      contentHash: input.contentHash,
      createdByUserId: input.createdByUserId ?? null,
      receivedAt: now,
      createdAt: now,
      validatedAt: input.validationErrors === undefined ? now : null,
    };
    this.configurationRevisions.set(revision.id, revision);
    return revision;
  }

  async activateProjectConfigurationRevision(
    projectId: string,
    revisionId: string,
    routes?: readonly ProjectTriggerRoute[],
  ) {
    const project = this.projects.get(projectId);
    const revision = this.configurationRevisions.get(revisionId);
    if (project?.status !== "active" || revision?.projectId !== projectId)
      throw new Error("configuration revision not found");
    if (revision.validationErrors !== null) throw new Error("invalid configuration revision");
    this.projectTriggerRoutes.set(projectId, [
      ...(routes ?? this.projectTriggerRoutes.get(projectId) ?? []),
    ]);
    this.projects.set(projectId, {
      ...project,
      activeConfigurationRevisionId: revisionId,
      updatedAt: new Date(),
    });
    return revision;
  }

  async findProjectConfigurationRollbackTarget(projectId: string) {
    const active = await this.findActiveProjectConfiguration(projectId);
    return Array.from(this.configurationRevisions.values())
      .filter(
        (revision) =>
          revision.projectId === projectId &&
          revision.validationErrors === null &&
          active !== undefined &&
          revision.version < active.version,
      )
      .sort((left, right) => right.version - left.version)[0];
  }

  async rollbackProjectConfiguration(
    projectId: string,
    targetRevisionId: string,
    routes: readonly ProjectTriggerRoute[],
  ) {
    const target = await this.findProjectConfigurationRollbackTarget(projectId);
    if (target?.id !== targetRevisionId) throw new Error("configuration rollback target changed");
    return this.activateProjectConfigurationRevision(projectId, targetRevisionId, routes);
  }

  async findActiveProjectConfiguration(projectId: string) {
    const revisionId = this.projects.get(projectId)?.activeConfigurationRevisionId;
    return revisionId === null || revisionId === undefined
      ? undefined
      : this.configurationRevisions.get(revisionId);
  }

  async findProjectConfigurationRevision(projectId: string, revisionId: string) {
    const revision = this.configurationRevisions.get(revisionId);
    return revision?.projectId === projectId ? revision : undefined;
  }

  async switchProjectConfigurationToManual(input: SwitchProjectConfigurationToManualInput) {
    const revision = await this.insertProjectConfigurationRevision({
      projectId: input.projectId,
      sourceKind: "manual",
      sourceEvidence: {
        kind: "authority-switch",
        formattingPreserved: input.formattingPreserved,
      },
      rawYaml: input.rawYaml,
      normalizedConfiguration: input.normalizedConfiguration,
      contentHash: input.contentHash,
      createdByUserId: input.userId,
    });
    this.configurationAuthorities.set(input.projectId, "manual");
    this.githubConfigurationSources.delete(input.projectId);
    return this.activateProjectConfigurationRevision(input.projectId, revision.id, input.routes);
  }

  async setProjectGitHubConfigurationSource(
    input: SetProjectGitHubConfigurationSourceInput,
  ): Promise<void> {
    const project = this.projects.get(input.projectId);
    if (project?.status !== "active") throw new Error("project access denied");
    this.configurationAuthorities.set(input.projectId, "github");
    this.githubConfigurationSources.set(input.projectId, {
      githubConnectionId: input.githubConnectionId,
      githubRepositoryId: input.githubRepositoryId,
      githubRepositoryFullName: input.githubRepositoryFullName,
      githubDefaultBranch: input.githubDefaultBranch,
      automaticDeploymentEnabled: input.automaticDeploymentEnabled,
    });
  }

  async recordConfigurationSyncAttempt(
    input: RecordConfigurationSyncAttemptInput,
  ): Promise<ConfigurationSyncAttemptRecord> {
    const attempt: ConfigurationSyncAttemptRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      githubConnectionId: input.githubConnectionId,
      githubRepositoryId: input.githubRepositoryId,
      webhookDeliveryId: input.webhookDeliveryId,
      commitSha: input.commitSha,
      outcome: input.outcome,
      evidence: structuredClone(input.evidence),
      createdAt: this.options.now?.() ?? new Date(),
    };
    const attempts = this.configurationSyncAttempts.get(input.projectId) ?? [];
    attempts.push(attempt);
    this.configurationSyncAttempts.set(input.projectId, attempts);
    return attempt;
  }

  async projectConfigurationReadModel(projectId: string) {
    const authority = this.configurationAuthorities.get(projectId);
    if (authority === undefined) throw new Error("configuration authority not found");
    return {
      authority,
      activeRevision: (await this.findActiveProjectConfiguration(projectId)) ?? null,
      lastSyncAttempt: this.configurationSyncAttempts.get(projectId)?.at(-1) ?? null,
      sourceState:
        authority === "manual"
          ? ({ kind: "manual", formattingPreserved: false } as const)
          : ({
              kind: "github",
              githubConnectionId:
                this.githubConfigurationSources.get(projectId)?.githubConnectionId ?? "unavailable",
              githubRepositoryId:
                this.githubConfigurationSources.get(projectId)?.githubRepositoryId ?? 0,
              githubRepositoryFullName:
                this.githubConfigurationSources.get(projectId)?.githubRepositoryFullName ??
                "unavailable",
              githubDefaultBranch:
                this.githubConfigurationSources.get(projectId)?.githubDefaultBranch ?? "main",
              automaticDeploymentEnabled:
                this.githubConfigurationSources.get(projectId)?.automaticDeploymentEnabled ?? false,
            } as const),
    };
  }

  async organizationConnectionUsage(organizationId: string): Promise<OrganizationConnectionUsage> {
    return {
      github: Array.from(this.githubConnections.values()).filter(
        (connection) => connection.organizationId === organizationId,
      ),
      discord: Array.from(this.discordConnections.values()).filter(
        (connection) => connection.organizationId === organizationId,
      ),
      slack: Array.from(this.slackConnections.values()).filter(
        (connection) => connection.organizationId === organizationId,
      ),
    };
  }

  async listGitHubRepositories(organizationId: string) {
    return Array.from(this.githubRepositories.values()).filter(
      (repository) => repository.organizationId === organizationId,
    );
  }

  async findGitHubRepositoryForOrganization(organizationId: string, fullName: string) {
    const rows = Array.from(this.githubRepositories.values()).filter(
      (repository) =>
        repository.organizationId === organizationId && repository.fullName === fullName,
    );
    if (rows.length > 1) throw new Error("github repository resource is ambiguous");
    return rows[0];
  }

  async upsertGitHubRepositories(
    organizationId: string,
    connectionId: string,
    repositories: Array<
      Pick<GitHubRepositoryRecord, "repositoryId" | "fullName" | "defaultBranch">
    >,
  ) {
    for (const repository of repositories) {
      const id =
        this.githubRepositories.get(`${connectionId}:${repository.repositoryId}`)?.id ??
        randomUUID();
      this.githubRepositories.set(`${connectionId}:${repository.repositoryId}`, {
        id,
        organizationId,
        connectionId,
        ...repository,
      });
    }
  }

  async findGitHubConfigurationTarget(
    projectId: string,
    repositoryId?: number,
  ): Promise<GitHubConfigurationTarget | undefined> {
    const source = this.githubConfigurationSources.get(projectId);
    if (
      source === undefined ||
      (repositoryId !== undefined && source.githubRepositoryId !== repositoryId)
    ) {
      return undefined;
    }
    const repository = Array.from(this.githubRepositories.values()).find(
      (candidate) =>
        candidate.connectionId === source.githubConnectionId &&
        candidate.repositoryId === source.githubRepositoryId,
    );
    const connection = Array.from(this.githubConnections.values()).find(
      (candidate) => candidate.id === source.githubConnectionId,
    );
    return repository === undefined || connection === undefined
      ? undefined
      : {
          ...repository,
          projectId,
          installationId: connection.installationId,
          automaticDeploymentEnabled: source.automaticDeploymentEnabled,
        };
  }

  async listGitHubConfigurationTargets(
    organizationId: string,
    connectionId: string,
    repositoryId: number,
  ): Promise<GitHubConfigurationTarget[]> {
    return Array.from(this.githubConfigurationSources.entries()).flatMap(([projectId, source]) => {
      const project = this.projects.get(projectId);
      if (
        project?.organizationId !== organizationId ||
        project.status !== "active" ||
        source.githubConnectionId !== connectionId ||
        source.githubRepositoryId !== repositoryId
      ) {
        return [];
      }
      const repository = Array.from(this.githubRepositories.values()).find(
        (candidate) =>
          candidate.connectionId === source.githubConnectionId &&
          candidate.repositoryId === source.githubRepositoryId,
      );
      const connection = Array.from(this.githubConnections.values()).find(
        (candidate) => candidate.id === source.githubConnectionId,
      );
      return repository === undefined || connection === undefined
        ? []
        : [
            {
              ...repository,
              projectId,
              installationId: connection.installationId,
              automaticDeploymentEnabled: source.automaticDeploymentEnabled,
            },
          ];
    });
  }

  async listUnroutedTriggersForOrganization(organizationId: string) {
    return [
      ...Array.from(this.triggers.values()).filter(
        (trigger) => trigger.organizationId === organizationId && trigger.projectId === null,
      ),
      ...Array.from(this.providerReceiptActivities.values()).filter(
        (receipt) =>
          receipt.organizationId === organizationId &&
          (this.triggerIdsByReceipt.get(receipt.receiptId)?.length ?? 0) === 0,
      ),
    ].sort(
      (left, right) =>
        right.receivedAt.getTime() - left.receivedAt.getTime() || right.id.localeCompare(left.id),
    );
  }

  async isOrganizationMember(): Promise<boolean> {
    return false;
  }

  startConnectionAttempt(_input: StartConnectionAttemptInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  readConnectionAttempt(_input: ReadConnectionAttemptInput) {
    return connectionPersistenceUnavailable();
  }

  consumeConnectionAttempt(_input: ReadConnectionAttemptInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  advanceGitHubConnectionAttempt(_input: AdvanceGitHubConnectionAttemptInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  bindGitHubConnection(_input: BindGitHubConnectionInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  bindDiscordConnection(_input: BindDiscordConnectionInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  bindSlackConnection(_input: BindSlackConnectionInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  disconnectConnection(
    _provider: ConnectionProvider,
    _connectionId: string,
    _access: ConnectionStartAuthority,
  ) {
    return connectionPersistenceUnavailable();
  }

  findGitHubConnection(_installationId: number): Promise<GitHubConnectionRecord | undefined> {
    return Promise.resolve(this.githubConnections.get(_installationId));
  }

  findDiscordConnection(_guildId: string): Promise<DiscordConnectionRecord | undefined> {
    return Promise.resolve(this.discordConnections.get(_guildId));
  }

  findSlackConnection(_teamId: string): Promise<SlackConnectionRecord | undefined> {
    return Promise.resolve(this.slackConnections.get(_teamId));
  }

  findSlackConnectionForOrganization(
    organizationId: string,
    teamId: string,
  ): Promise<SlackConnectionRecord | undefined> {
    const connection = this.slackConnections.get(teamId);
    return Promise.resolve(connection?.organizationId === organizationId ? connection : undefined);
  }

  findDiscordConnectionForOrganization(
    organizationId: string,
    guildId: string,
  ): Promise<DiscordConnectionRecord | undefined> {
    const connection = this.discordConnections.get(guildId);
    return Promise.resolve(connection?.organizationId === organizationId ? connection : undefined);
  }

  removeDiscordConnection(): Promise<void> {
    return Promise.resolve();
  }

  private async deleteLifecycleClaim(id: string): Promise<void> {
    const trigger = this.triggers.get(id);
    if (trigger?.droppedReason !== "github_lifecycle") return;
    this.triggers.delete(id);
    this.triggersByDeliveryId.delete(
      triggerDeliveryKey(trigger.organizationId, trigger.deliveryId),
    );
    if (trigger.signatureHash !== null) this.triggersBySignatureHash.delete(trigger.signatureHash);
  }

  async close(): Promise<void> {}

  private readTrigger(id: string): TriggerRecord {
    const trigger = this.triggers.get(id);

    if (trigger === undefined) {
      throw new Error(`trigger not found: ${id}`);
    }

    return trigger;
  }

  private async acceptMemoryTrigger(
    input: AcceptGitHubTriggerInput | AcceptDiscordTriggerInput | AcceptSlackTriggerInput,
    organizationId: string | undefined,
    connectionId: string | undefined,
    resourceId: string | null,
    reason: string | undefined,
  ): Promise<ProviderTriggerAcceptance> {
    const receiptId = this.receiptIdsByDelivery.get(input.deliveryId);
    if (receiptId !== undefined) {
      return {
        status: "duplicate",
        triggerIds: this.triggerIdsByReceipt.get(receiptId) ?? [],
        receiptId,
      };
    }
    const newReceiptId = randomUUID();
    this.receiptIdsByDelivery.set(input.deliveryId, newReceiptId);
    if (organizationId !== undefined) {
      this.providerReceiptActivities.set(newReceiptId, {
        id: newReceiptId,
        organizationId,
        projectId: null,
        configurationRevisionId: null,
        receiptId: newReceiptId,
        connectionId: connectionId ?? null,
        resourceId,
        deliveryId: input.deliveryId,
        signatureHash: input.signatureHash ?? null,
        source: input.source,
        repo: input.repo ?? null,
        payload: input.payload,
        receivedAt: input.receivedAt,
        matchedTriggerName: null,
        configuredTriggerNames: [],
        droppedReason: reason ?? null,
      });
    }
    if (reason !== undefined || organizationId === undefined || connectionId === undefined) {
      return {
        status: "dropped",
        receiptId: newReceiptId,
        reason: reason ?? "provider_unbound",
      };
    }
    const provider = providerForInput(input);
    const routes = Array.from(this.projectTriggerRoutes.entries()).flatMap(
      ([projectId, candidates]) => {
        const project = this.projects.get(projectId);
        return project?.status === "active" && project.activeConfigurationRevisionId !== null
          ? candidates
              .filter(
                (route) =>
                  route.provider === provider &&
                  route.connectionId === connectionId &&
                  (route.resourceId === null || route.resourceId === resourceId),
              )
              .map((route) => Object.assign({}, route, { projectId }))
          : [];
      },
    );
    if (routes.length === 0) {
      const activity = this.providerReceiptActivities.get(newReceiptId);
      if (activity !== undefined) {
        this.providerReceiptActivities.set(activity.id, {
          ...activity,
          droppedReason: "provider_unrouted",
        });
      }
      return { status: "dropped", receiptId: newReceiptId, reason: "provider_unrouted" };
    }
    const projectRoutes = new Map<string, (typeof routes)[number]>();
    for (const route of routes) {
      if (!projectRoutes.has(route.projectId)) projectRoutes.set(route.projectId, route);
    }

    const triggers: DurableTrigger[] = [];
    for (const route of projectRoutes.values()) {
      const result = await this.insertTrigger({
        organizationId,
        projectId: route.projectId,
        configurationRevisionId: this.projects.get(route.projectId)!.activeConfigurationRevisionId,
        receiptId: newReceiptId,
        connectionId,
        resourceId,
        deliveryId: input.deliveryId,
        signatureHash: input.signatureHash ?? null,
        source: input.source,
        repo: input.repo ?? null,
        payload: input.payload,
        receivedAt: input.receivedAt,
        matchedTriggerName: route.triggerName,
      });
      triggers.push(durableTrigger(result.trigger));
    }
    return { status: "accepted", triggers, receiptId: newReceiptId };
  }

  private readMachine(id: string): MachineRecord {
    const machine = this.machines.get(id);

    if (machine === undefined) {
      throw new Error(`machine not found: ${id}`);
    }

    return machine;
  }

  private readAgentExecution(id: string): AgentExecutionRecord {
    const execution = this.agentExecutions.get(id);

    if (execution === undefined) {
      throw new Error(`agent execution not found: ${id}`);
    }

    return execution;
  }
}

function connectionPersistenceUnavailable(): never {
  throw new Error("connection persistence requires PostgreSQL");
}

function durableTrigger(trigger: TriggerRecord): DurableTrigger {
  if (trigger.projectId === null) throw new Error("durable trigger has no project tenant");
  return {
    triggerId: trigger.id,
    organizationId: trigger.organizationId,
    projectId: trigger.projectId,
    deliveryId: trigger.deliveryId,
    source: trigger.source,
    payload: trigger.payload,
    receivedAt: trigger.receivedAt,
    connectionId: trigger.connectionId,
    resourceId: trigger.resourceId,
  };
}

function providerForInput(
  input: AcceptGitHubTriggerInput | AcceptDiscordTriggerInput | AcceptSlackTriggerInput,
): "github" | "discord" | "slack" {
  if ("installationId" in input) return "github";
  if ("guildId" in input) return "discord";
  return "slack";
}

function githubDropReason(
  input: AcceptGitHubTriggerInput,
  binding: GitHubConnectionRecord | undefined,
): string | undefined {
  if (input.dropReason !== undefined) return input.dropReason;
  if (binding === undefined) return "github_unbound";
  if (binding.status === "suspended") return "github_suspended";
  return undefined;
}

function discordDropReason(
  input: AcceptDiscordTriggerInput,
  binding: DiscordConnectionRecord | undefined,
): string | undefined {
  if (input.dropReason !== undefined) return input.dropReason;
  if (binding === undefined) return "discord_unbound";
  return undefined;
}

function slackDropReason(
  input: AcceptSlackTriggerInput,
  binding: SlackConnectionRecord | undefined,
): string | undefined {
  if (input.dropReason !== undefined) return input.dropReason;
  if (binding === undefined) return "slack_unbound";
  return undefined;
}

interface MemoryDeviceAuthorization extends DeviceAuthorizationRecord {
  deviceVerifier: string;
  userCodeVerifier: string;
  fingerprintVerifier: string;
  nextPollAt: Date;
  enrollmentTokenVerifier: string | null;
}

function workflowDeadlineKind(
  execution: AgentExecutionRecord | undefined,
  step: WorkflowStepRunRecord,
  run: AcceptedTriggerRunRecord,
  observedAt: Date,
): WorkflowDeadlineKind | undefined {
  if (run.status === "running" && run.deadlineAt <= observedAt) return "whole_run";
  const hardDeadline = execution?.deadlineAt ?? step.deadlineAt;
  const idleDeadline = execution?.idleDeadlineAt ?? step.idleDeadlineAt;
  if (hardDeadline !== null && hardDeadline !== undefined && hardDeadline <= observedAt) {
    if (
      idleDeadline !== null &&
      idleDeadline !== undefined &&
      idleDeadline <= observedAt &&
      idleDeadline < hardDeadline
    ) {
      return "step_idle";
    }
    return "step_hard";
  }
  if (idleDeadline !== null && idleDeadline !== undefined && idleDeadline <= observedAt) {
    return "step_idle";
  }
  return undefined;
}

function capIdleDeadline(
  idleDeadlineAt: Date | null | undefined,
  deadlineAt: Date | null,
): Date | null {
  if (idleDeadlineAt === null || idleDeadlineAt === undefined || deadlineAt === null) {
    return idleDeadlineAt ?? null;
  }
  return new Date(Math.min(idleDeadlineAt.getTime(), deadlineAt.getTime()));
}

function isTerminalAgentExecutionStatus(status: AgentExecutionStatus): boolean {
  return status === "succeeded" || status === "failed";
}

function triggerDeliveryKey(organizationId: string, deliveryId: string): string {
  return `${organizationId}:${deliveryId}`;
}

function freezeEvidence<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeEvidence(child);
  return Object.freeze(value);
}
