import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { parseInvocationInputs, parseInvocationRejection } from "../triggers/invocation.js";
import { toDatabaseError } from "./errors.js";
import {
  type AgentExecutionRow,
  toAgentExecutionRecord,
  toProviderEventReceiptRecord,
  toProviderEventReceiptSummary,
} from "./mappers.js";
import type {
  AcceptedTriggerRunRecord,
  AgentExecutionRecord,
  ConsumeOrganizationUsageInput,
  CreateAcceptedTriggerRunInput,
  CreateRejectedTriggerRunInput,
  InsertAgentExecutionInput,
  OrganizationUsageRecord,
  ProjectActivityRunListRecord,
  ProjectActivityRunRecord,
  ProviderEventReceiptRecord,
  RejectedTriggerRunRecord,
  TransitionAgentExecutionFields,
  TransitionAgentExecutionResult,
  TriggerRunRecord,
  WorkflowAgentCompletionInput,
  WorkflowDeadlineKind,
  WorkflowDeadlineRecovery,
  WorkflowStepExecutionInput,
  WorkflowStepRunRecord,
  WorkflowWakeupRecord,
} from "./types.js";

type DatabaseQuery = <T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  text: string,
  values?: unknown[],
) => Promise<QueryResult<T>>;

interface WorkflowRepositoryDependencies {
  query: DatabaseQuery;
  insertAgentExecution(
    client: PoolClient,
    input: InsertAgentExecutionInput,
  ): Promise<AgentExecutionRow>;
  reserveOrganizationUsage(
    client: PoolClient,
    input: ConsumeOrganizationUsageInput,
  ): Promise<OrganizationUsageRecord | undefined>;
  findAgentExecutionById(id: string): Promise<AgentExecutionRecord | undefined>;
  transitionAgentExecution(
    id: string,
    toStatus: "succeeded" | "failed",
    fields?: TransitionAgentExecutionFields,
  ): Promise<TransitionAgentExecutionResult>;
}

function transitionWithTerminalRun(
  transition: TransitionAgentExecutionResult,
  run: TriggerRunRecord | undefined,
): TransitionAgentExecutionResult {
  return !transition.transitioned || run === undefined || run.status === "running"
    ? transition
    : { ...transition, terminalRun: run };
}

export class WorkflowRepository {
  constructor(
    private readonly pool: Pool,
    private readonly dependencies: WorkflowRepositoryDependencies,
  ) {}

  async createAcceptedTriggerRun(
    input: CreateAcceptedTriggerRunInput,
  ): Promise<{ run: AcceptedTriggerRunRecord; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const inserted = await client.query<TriggerRunRow>(
        `insert into trigger_runs
           (id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
           configured_trigger_name, outcome, status,
            raw_prompt, prompt, inputs, values, trigger_context, output_context, deadline_at, deadline_kind, rejection, created_at)
         values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, 'accepted', 'running', $7, $8, $9, '{}'::jsonb, $10, $11, $12, null, null, $13)
         on conflict (provider_event_receipt_id, project_id, configured_trigger_name) do nothing
         returning *`,
        [
          input.id ?? null,
          input.organizationId,
          input.projectId,
          input.configurationRevisionId,
          input.providerEventReceiptId,
          input.configuredTriggerName,
          input.rawPrompt,
          input.prompt,
          input.inputs,
          input.triggerContext,
          input.outputContext,
          input.deadlineAt,
          input.createdAt ?? new Date(),
        ],
      );
      let run = inserted.rows[0];
      const created = run !== undefined;
      if (run === undefined) {
        const existing = await client.query<TriggerRunRow>(
          `select * from trigger_runs
           where provider_event_receipt_id = $1 and project_id = $2 and configured_trigger_name = $3
           for update`,
          [input.providerEventReceiptId, input.projectId, input.configuredTriggerName],
        );
        run = existing.rows[0];
      }
      if (run === undefined) throw new Error("trigger run insert returned no row");
      if (run.outcome !== "accepted") throw new Error("trigger branch outcome conflict");
      for (const [ordinal, stepId] of input.stepIds.entries()) {
        await client.query(
          `insert into workflow_step_runs
             (trigger_run_id, step_id, ordinal, status, deadline_kind, deadline_at, idle_deadline_at)
           values ($1, $2, $3, 'pending', null, null, null)
           on conflict (trigger_run_id, ordinal) do nothing`,
          [run.id, stepId, ordinal],
        );
      }
      await client.query(
        `insert into workflow_wakeups (trigger_run_id, available_at, lease_expires_at)
         values ($1, $2, null)
         on conflict (trigger_run_id) do nothing`,
        [run.id, input.createdAt ?? new Date()],
      );
      await client.query("commit");
      const record = toTriggerRunRecord(run);
      if (record.outcome !== "accepted") throw new Error("trigger branch outcome conflict");
      return { run: record, created };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async createRejectedTriggerRun(
    input: CreateRejectedTriggerRunInput,
  ): Promise<{ run: RejectedTriggerRunRecord; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const createdAt = input.createdAt ?? new Date();
      const inserted = await client.query<TriggerRunRow>(
        `insert into trigger_runs
           (id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
           configured_trigger_name, outcome, status,
            raw_prompt, prompt, inputs, values, trigger_context, output_context, deadline_at, rejection, created_at, completed_at)
         values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, 'rejected', 'rejected',
                 $7, $8, $9, '{}'::jsonb, $10, $11, null, $13, $12, $12)
         on conflict (provider_event_receipt_id, project_id, configured_trigger_name) do nothing
         returning *`,
        [
          input.id ?? null,
          input.organizationId,
          input.projectId,
          input.configurationRevisionId,
          input.providerEventReceiptId,
          input.configuredTriggerName,
          input.rawPrompt,
          input.prompt,
          input.inputs,
          input.triggerContext,
          input.outputContext,
          createdAt,
          input.rejection,
        ],
      );
      let run = inserted.rows[0];
      const created = run !== undefined;
      if (run === undefined) {
        const existing = await client.query<TriggerRunRow>(
          `select * from trigger_runs
           where provider_event_receipt_id = $1 and project_id = $2 and configured_trigger_name = $3
           for update`,
          [input.providerEventReceiptId, input.projectId, input.configuredTriggerName],
        );
        run = existing.rows[0];
      }
      if (run === undefined) throw new Error("trigger run insert returned no row");
      if (run.outcome !== "rejected") throw new Error("trigger branch outcome conflict");
      await client.query("commit");
      const record = toTriggerRunRecord(run);
      if (record.outcome !== "rejected") throw new Error("trigger branch outcome conflict");
      return { run: record, created };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async findTriggerRunById(id: string) {
    const rows = await this.dependencies.query<TriggerRunRow>(
      this.pool,
      `select * from trigger_runs where id = $1`,
      [id],
    );
    return rows.rows[0] === undefined ? undefined : toTriggerRunRecord(rows.rows[0]);
  }

  async findTriggerRunsByProviderEventReceiptId(providerEventReceiptId: string) {
    const rows = await this.dependencies.query<TriggerRunRow>(
      this.pool,
      `select * from trigger_runs
       where provider_event_receipt_id = $1
       order by created_at, configured_trigger_name, id`,
      [providerEventReceiptId],
    );
    return rows.rows.map(toTriggerRunRecord);
  }

  async listTriggerRunsForProject(projectId: string, limit: number) {
    const rows = await this.dependencies.query<TriggerRunRow>(
      this.pool,
      `select * from trigger_runs
       where project_id = $1
       order by created_at desc, configured_trigger_name, id desc
       limit $2`,
      [projectId, limit],
    );
    return rows.rows.map(toTriggerRunRecord);
  }

  async findWorkflowStepRunById(id: string) {
    const rows = await this.dependencies.query<WorkflowStepRunRow>(
      this.pool,
      `select * from workflow_step_runs where id = $1`,
      [id],
    );
    return rows.rows[0] === undefined ? undefined : toWorkflowStepRunRecord(rows.rows[0]);
  }

  async findWorkflowStepRunByTriggerRun(triggerRunId: string) {
    const rows = await this.dependencies.query<WorkflowStepRunRow>(
      this.pool,
      `select * from workflow_step_runs where trigger_run_id = $1 order by ordinal limit 1`,
      [triggerRunId],
    );
    return rows.rows[0] === undefined ? undefined : toWorkflowStepRunRecord(rows.rows[0]);
  }

  async listWorkflowStepRunsForTriggerRun(triggerRunId: string) {
    const rows = await this.dependencies.query<WorkflowStepRunRow>(
      this.pool,
      `select * from workflow_step_runs where trigger_run_id = $1 order by ordinal`,
      [triggerRunId],
    );
    return rows.rows.map(toWorkflowStepRunRecord);
  }

  async findAgentExecutionByWorkflowStepRunId(stepRunId: string) {
    const rows = await this.dependencies.query<AgentExecutionRow>(
      this.pool,
      `select * from agent_executions where workflow_step_run_id = $1 limit 1`,
      [stepRunId],
    );
    return rows.rows[0] === undefined ? undefined : toAgentExecutionRecord(rows.rows[0]);
  }

  async claimWorkflowWakeup(now: Date, leaseMs: number) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<WorkflowWakeupRow>(
        `select * from workflow_wakeups
         where available_at <= $1
           and (lease_expires_at is null or lease_expires_at <= $1)
         order by available_at, trigger_run_id
         for update skip locked limit 1`,
        [now],
      );
      const wakeup = selected.rows[0];
      if (wakeup === undefined) {
        await client.query("commit");
        return undefined;
      }
      const updated = await client.query<WorkflowWakeupRow>(
        `update workflow_wakeups set lease_expires_at = $2 where trigger_run_id = $1 returning *`,
        [wakeup.trigger_run_id, new Date(now.getTime() + leaseMs)],
      );
      await client.query("commit");
      return toWorkflowWakeupRecord(updated.rows[0]!, wakeup.lease_expires_at !== null);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async wakeWorkflowRun(triggerRunId: string, availableAt: Date) {
    await this.dependencies.query(
      this.pool,
      `insert into workflow_wakeups (trigger_run_id, available_at, lease_expires_at)
       values ($1, $2, null)
       on conflict (trigger_run_id) do update
       set available_at = least(workflow_wakeups.available_at, excluded.available_at),
           lease_expires_at = null`,
      [triggerRunId, availableAt],
    );
  }

  async deleteWorkflowWakeup(triggerRunId: string) {
    await this.dependencies.query(
      this.pool,
      `delete from workflow_wakeups where trigger_run_id = $1`,
      [triggerRunId],
    );
  }

  async createWorkflowStepExecution(input: WorkflowStepExecutionInput) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const startedAt = input.execution.startedAt;
      const runRows = await client.query<TriggerRunRow>(
        `select * from trigger_runs where id = $1 for update`,
        [input.triggerRunId],
      );
      const run = runRows.rows[0];
      if (run === undefined) throw new Error("workflow trigger run not found");
      if (run.outcome !== "accepted" || run.status !== "running") {
        await client.query("commit");
        const stepRows = await client.query<WorkflowStepRunRow>(
          `select * from workflow_step_runs where trigger_run_id = $1 and step_id = $2 and ordinal = $3`,
          [input.triggerRunId, input.stepId, input.ordinal],
        );
        const step = stepRows.rows[0];
        if (step === undefined) throw new Error("workflow step run not found");
        return { stepRun: toWorkflowStepRunRecord(step), execution: undefined, created: false };
      }
      if (run.deadline_at === null || run.deadline_at.getTime() <= startedAt.getTime()) {
        await timeoutWorkflowRunOnClient(client, run, startedAt);
        const stepRows = await client.query<WorkflowStepRunRow>(
          `select * from workflow_step_runs where trigger_run_id = $1 and step_id = $2 and ordinal = $3`,
          [input.triggerRunId, input.stepId, input.ordinal],
        );
        const step = stepRows.rows[0];
        await client.query("commit");
        if (step === undefined) throw new Error("workflow step run not found");
        return { stepRun: toWorkflowStepRunRecord(step), execution: undefined, created: false };
      }
      const deadlineAt = new Date(
        Math.min(input.execution.deadlineAt.getTime(), run.deadline_at.getTime()),
      );
      const idleDeadlineAt = new Date(
        Math.min(
          input.execution.idleDeadlineAt.getTime(),
          deadlineAt.getTime(),
          run.deadline_at.getTime(),
        ),
      );
      const selected = await client.query<WorkflowStepRunRow>(
        `select * from workflow_step_runs where trigger_run_id = $1 and step_id = $2 and ordinal = $3 for update`,
        [input.triggerRunId, input.stepId, input.ordinal],
      );
      let step = selected.rows[0];
      if (step === undefined) throw new Error("workflow step run not found");
      if (step.agent_execution_id !== null) {
        const existing = await client.query<AgentExecutionRow>(
          `select * from agent_executions where id = $1`,
          [step.agent_execution_id],
        );
        await client.query("commit");
        return {
          stepRun: toWorkflowStepRunRecord(step),
          execution:
            existing.rows[0] === undefined ? undefined : toAgentExecutionRecord(existing.rows[0]),
          created: false,
        };
      }
      const execution = await this.dependencies.insertAgentExecution(client, {
        ...input.execution,
        id: input.executionId,
        deadlineAt,
        idleDeadlineAt,
        workflowStepRunId: step.id,
      });
      // Reserve one meter unit in the same transaction that creates the execution. If the
      // reservation is denied the whole transaction rolls back, so no execution is created and
      // nothing is dispatched — metering is atomic with the work it permits.
      if (input.reservation !== undefined) {
        const reserved = await this.dependencies.reserveOrganizationUsage(client, {
          organizationId: input.execution.organizationId,
          meter: input.reservation.meter,
          periodStart: input.reservation.periodStart,
          amount: 1,
          limit: input.reservation.limit,
        });
        if (reserved === undefined) {
          if (input.reservation.limit === null) {
            throw new Error("unreachable: an unlimited meter reservation cannot be denied");
          }
          const usage = await client.query<OrganizationUsageRow>(
            `select used from organization_usage
             where organization_id = $1 and meter = $2 and period_start = $3`,
            [
              input.execution.organizationId,
              input.reservation.meter,
              input.reservation.periodStart,
            ],
          );
          await client.query("rollback");
          return {
            stepRun: toWorkflowStepRunRecord(step),
            execution: undefined,
            created: false,
            reservationDenied: {
              meter: input.reservation.meter,
              limit: input.reservation.limit,
              current: Number(usage.rows[0]?.used ?? 0),
            },
          };
        }
      }
      const updated = await client.query<WorkflowStepRunRow>(
        `update workflow_step_runs
         set status = 'running', agent_execution_id = $2, started_at = coalesce(started_at, $3),
             deadline_at = $4, idle_deadline_at = $5, dispatch_intent = coalesce($6, dispatch_intent)
         where id = $1 and agent_execution_id is null
         returning *`,
        [
          step.id,
          execution.id,
          execution.started_at,
          execution.deadline_at,
          execution.idle_deadline_at,
          input.execution.launchIntent ?? null,
        ],
      );
      step = updated.rows[0] ?? step;
      await client.query("commit");
      return {
        stepRun: toWorkflowStepRunRecord(step),
        execution: toAgentExecutionRecord(execution),
        created: true,
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async linkWorkflowStepRunExecution(
    stepRunId: string,
    executionId: string,
    dispatchIntent?: LaunchMachineIntent,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<WorkflowStepRunRow>(
        `select * from workflow_step_runs where id = $1 for update`,
        [stepRunId],
      );
      const step = selected.rows[0];
      if (step === undefined) throw new Error(`workflow step run not found: ${stepRunId}`);
      if (step.agent_execution_id !== null && step.agent_execution_id !== executionId) {
        throw new Error(`workflow step run already linked: ${stepRunId}`);
      }
      if (step.agent_execution_id === executionId) {
        await client.query("commit");
        return toWorkflowStepRunRecord(step);
      }
      const execution = await client.query<AgentExecutionRow>(
        `select * from agent_executions where id = $1`,
        [executionId],
      );
      const executionRow = execution.rows[0];
      if (executionRow === undefined) throw new Error(`agent execution not found: ${executionId}`);
      const updated = await client.query<WorkflowStepRunRow>(
        `update workflow_step_runs
         set status = case when status = 'pending' then 'running' else status end,
             agent_execution_id = $2, started_at = coalesce(started_at, $3),
             dispatch_intent = coalesce($4, dispatch_intent)
         where id = $1 and agent_execution_id is null
         returning *`,
        [stepRunId, executionId, executionRow.started_at, dispatchIntent ?? null],
      );
      await client.query("commit");
      return toWorkflowStepRunRecord(updated.rows[0] ?? step);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async completeWorkflowStep(
    executionId: string,
    status: "succeeded" | "failed" | "timed_out",
    result: unknown,
    failureReason?: string,
  ) {
    const execution = await this.dependencies.findAgentExecutionById(executionId);
    if (execution === undefined || execution.workflowStepRunId === null) return undefined;
    await this.completeWorkflowAgentExecution({
      executionId,
      executionStatus: execution.status === "succeeded" ? "succeeded" : "failed",
      stepStatus: status,
      result,
      stepOutput: result,
      ...(failureReason === undefined ? {} : { failureReason }),
    });
    const step = await this.findWorkflowStepRunById(execution.workflowStepRunId);
    return step === undefined
      ? undefined
      : {
          stepRun: step,
          run: (await this.findTriggerRunById(step.triggerRunId))!,
        };
  }

  async completeWorkflowAgentExecution(input: WorkflowAgentCompletionInput) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const initialExecution = await client.query<AgentExecutionRow>(
        `select * from agent_executions where id = $1`,
        [input.executionId],
      );
      const initial = initialExecution.rows[0];
      if (initial === undefined) throw new Error(`agent execution not found: ${input.executionId}`);
      if (initial.workflow_step_run_id === null) {
        await client.query("commit");
        return this.dependencies.transitionAgentExecution(
          input.executionId,
          input.executionStatus,
          {
            result: input.result,
            ...(input.completedByAgent === undefined
              ? {}
              : { completedByAgent: input.completedByAgent }),
            ...(input.deadlineCondition === undefined
              ? {}
              : { deadlineCondition: input.deadlineCondition }),
            ...(input.hubAction === undefined ? {} : { hubAction: input.hubAction }),
          },
        );
      }

      const stepLookup = await client.query<WorkflowStepRunRow>(
        `select * from workflow_step_runs where id = $1`,
        [initial.workflow_step_run_id],
      );
      const stepCandidate = stepLookup.rows[0];
      if (stepCandidate === undefined) throw new Error("workflow step run not found");
      const runRows = await client.query<TriggerRunRow>(
        `select * from trigger_runs where id = $1 for update`,
        [stepCandidate.trigger_run_id],
      );
      const run = runRows.rows[0];
      if (run === undefined) throw new Error("workflow trigger run not found");
      const stepRows = await client.query<WorkflowStepRunRow>(
        `select * from workflow_step_runs where id = $1 for update`,
        [initial.workflow_step_run_id],
      );
      const step = stepRows.rows[0];
      if (step === undefined) throw new Error("workflow step run not found");

      const executionRows = await client.query<AgentExecutionRow>(
        `select * from agent_executions where id = $1 for update`,
        [input.executionId],
      );
      const execution = executionRows.rows[0];
      if (execution === undefined)
        throw new Error(`agent execution not found: ${input.executionId}`);
      const observedAt = input.observedAt ?? new Date();
      if (execution.status === "spawning" || execution.status === "running") {
        const deadlineKind = workflowDeadlineKind(execution, step, run, observedAt);
        if (deadlineKind === "whole_run") {
          const recovery = await timeoutWorkflowRunOnClient(client, run, observedAt);
          const terminalRun = await findTriggerRunOnClient(client, run.id);
          const updatedExecution = await findAgentExecutionOnClient(client, input.executionId);
          await client.query("commit");
          return transitionWithTerminalRun(
            {
              execution: updatedExecution ?? toAgentExecutionRecord(execution),
              transitioned: recovery.executionIds.includes(input.executionId),
              deadlineKind,
            },
            terminalRun,
          );
        }
        if (deadlineKind !== undefined) {
          const updated = await timeoutWorkflowStepOnClient(
            client,
            execution,
            step,
            run,
            deadlineKind,
            observedAt,
          );
          const terminalRun = await findTriggerRunOnClient(client, run.id);
          await client.query("commit");
          return transitionWithTerminalRun(
            {
              execution: toAgentExecutionRecord(updated),
              transitioned: true,
              deadlineKind,
            },
            terminalRun,
          );
        }
      }

      const liveTransition = await transitionWorkflowAgentExecution(client, execution, input);
      if (liveTransition === undefined) {
        await client.query("commit");
        return { execution: toAgentExecutionRecord(execution), transitioned: false };
      }

      await finishWorkflowStepAndRun(client, step, run, input);
      const terminalRun = await findTriggerRunOnClient(client, run.id);

      await client.query("commit");
      return transitionWithTerminalRun(
        {
          execution: toAgentExecutionRecord(liveTransition.execution),
          transitioned: liveTransition.transitioned,
          ...(input.deadlineKind === undefined ? {} : { deadlineKind: input.deadlineKind }),
        },
        terminalRun,
      );
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async markWorkflowStepSkipped(triggerRunId: string, stepId: string, reason: string) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const stepRows = await client.query<WorkflowStepRunRow>(
        `select * from workflow_step_runs where trigger_run_id = $1 and step_id = $2 for update`,
        [triggerRunId, stepId],
      );
      const step = stepRows.rows[0];
      const runRows = await client.query<TriggerRunRow>(
        `select * from trigger_runs where id = $1 for update`,
        [triggerRunId],
      );
      const run = runRows.rows[0];
      if (step === undefined || run === undefined) {
        await client.query("commit");
        return undefined;
      }
      if (step.status !== "pending") {
        await client.query("commit");
        return { stepRun: toWorkflowStepRunRecord(step), run: toTriggerRunRecord(run) };
      }
      const completedAt = new Date();
      const updatedRows = await client.query<WorkflowStepRunRow>(
        `update workflow_step_runs
         set status = 'skipped', failure_reason = $2, completed_at = $3
         where id = $1 and status = 'pending' returning *`,
        [step.id, reason, completedAt],
      );
      await client.query(
        `insert into workflow_wakeups (trigger_run_id, available_at, lease_expires_at)
         values ($1, $2, null)
         on conflict (trigger_run_id) do update
         set available_at = least(workflow_wakeups.available_at, excluded.available_at), lease_expires_at = null`,
        [triggerRunId, completedAt],
      );
      await client.query("commit");
      return {
        stepRun: toWorkflowStepRunRecord(updatedRows.rows[0] ?? step),
        run: toTriggerRunRecord(run),
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async succeedTriggerRun(triggerRunId: string) {
    const rows = await this.dependencies.query<TriggerRunRow>(
      this.pool,
      `update trigger_runs
       set status = 'succeeded', completed_at = now(),
           terminal_notification_pending_at = coalesce(terminal_notification_pending_at, now()),
           terminal_notification_lease_expires_at = null
       where id = $1 and status = 'running' returning *`,
      [triggerRunId],
    );
    if (rows.rows[0] === undefined) {
      const run = await this.findTriggerRunById(triggerRunId);
      return run === undefined ? undefined : { run, transitioned: false };
    }
    await this.deleteWorkflowWakeup(triggerRunId);
    return { run: toTriggerRunRecord(rows.rows[0]), transitioned: true };
  }

  async failWorkflowRun(
    triggerRunId: string,
    status: "failed" | "timed_out",
    failureReason: string,
    stepId?: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const runRows = await client.query<TriggerRunRow>(
        `select * from trigger_runs where id = $1 for update`,
        [triggerRunId],
      );
      const run = runRows.rows[0];
      const stepRows = await client.query<WorkflowStepRunRow>(
        `select * from workflow_step_runs
         where trigger_run_id = $1 and ($2::text is null or step_id = $2)
         order by ordinal limit 1 for update`,
        [triggerRunId, stepId ?? null],
      );
      const step = stepRows.rows[0];
      if (run === undefined || step === undefined) {
        await client.query("commit");
        return undefined;
      }
      if (run.status !== "running") {
        await client.query("commit");
        return {
          stepRun: toWorkflowStepRunRecord(step),
          run: toTriggerRunRecord(run),
          transitioned: false,
        };
      }
      const completedAt = new Date();
      const updatedStep = await client.query<WorkflowStepRunRow>(
        `update workflow_step_runs
         set status = case when status in ('pending', 'running') then $2 else status end,
             failure_reason = case when status in ('pending', 'running') then $3 else failure_reason end,
             completed_at = case when status in ('pending', 'running') then $4 else completed_at end
         where id = $1 returning *`,
        [step.id, status, failureReason, completedAt],
      );
      const updatedRun = await client.query<TriggerRunRow>(
        `update trigger_runs
         set status = $2, failure_reason = $3, completed_at = $4,
             terminal_notification_pending_at = coalesce(terminal_notification_pending_at, $4),
             terminal_notification_lease_expires_at = null
         where id = $1 returning *`,
        [triggerRunId, status, failureReason, completedAt],
      );
      await client.query(`delete from workflow_wakeups where trigger_run_id = $1`, [triggerRunId]);
      await client.query("commit");
      return {
        stepRun: toWorkflowStepRunRecord(updatedStep.rows[0] ?? step),
        run: toTriggerRunRecord(updatedRun.rows[0]!),
        transitioned: true,
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async recoverWorkflowWakeups(now: Date) {
    await this.dependencies.query(
      this.pool,
      `insert into workflow_wakeups (trigger_run_id, available_at, lease_expires_at)
       select runs.id, $1, null
       from trigger_runs runs
       left join workflow_wakeups wakeups on wakeups.trigger_run_id = runs.id
       where runs.status = 'running'
         and runs.deadline_at > $1
         and not exists (
           select 1 from agent_executions executions
           join workflow_step_runs live_steps on live_steps.id = executions.workflow_step_run_id
           where live_steps.trigger_run_id = runs.id
             and executions.status in ('spawning', 'running')
         )
         and wakeups.trigger_run_id is null
       on conflict (trigger_run_id) do nothing`,
      [now],
    );
  }

  async claimPendingWorkflowRunTerminalNotification(now: Date, leaseMs: number) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<TriggerRunRow>(
        `select * from trigger_runs
         where outcome = 'accepted'
           and status <> 'running'
           and terminal_notification_pending_at is not null
           and terminal_notification_delivered_at is null
           and (
             terminal_notification_lease_expires_at is null
             or terminal_notification_lease_expires_at <= $1
           )
         order by terminal_notification_pending_at, id
         for update skip locked limit 1`,
        [now],
      );
      const run = selected.rows[0];
      if (run === undefined) {
        await client.query("commit");
        return undefined;
      }
      const updated = await client.query<TriggerRunRow>(
        `update trigger_runs
         set terminal_notification_lease_expires_at = $2
         where id = $1
         returning *`,
        [run.id, new Date(now.getTime() + leaseMs)],
      );
      await client.query("commit");
      return toTriggerRunRecord(updated.rows[0]!);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async markWorkflowRunTerminalNotificationDelivered(triggerRunId: string, deliveredAt: Date) {
    await this.dependencies.query(
      this.pool,
      `update trigger_runs
       set terminal_notification_delivered_at = coalesce(terminal_notification_delivered_at, $2),
           terminal_notification_lease_expires_at = null
       where id = $1
         and terminal_notification_pending_at is not null
         and terminal_notification_delivered_at is null`,
      [triggerRunId, deliveredAt],
    );
  }

  async recoverWorkflowDeadlines(now: Date): Promise<readonly WorkflowDeadlineRecovery[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const recoveries: WorkflowDeadlineRecovery[] = [];
      const overdueRuns = await client.query<TriggerRunRow>(
        `select * from trigger_runs
         where outcome = 'accepted' and status = 'running' and deadline_at <= $1
         order by deadline_at, id
         for update skip locked`,
        [now],
      );
      for (const run of overdueRuns.rows) {
        recoveries.push(await timeoutWorkflowRunOnClient(client, run, now));
      }

      const activeRuns = await client.query<TriggerRunRow>(
        `select * from trigger_runs
         where outcome = 'accepted' and status = 'running' and deadline_at > $1
         order by deadline_at, id
         for update skip locked`,
        [now],
      );
      for (const run of activeRuns.rows) {
        const steps = await client.query<WorkflowStepRunRow>(
          `select * from workflow_step_runs
           where trigger_run_id = $1 and status = 'running'
           order by ordinal
           for update`,
          [run.id],
        );
        for (const step of steps.rows) {
          const executionRows =
            step.agent_execution_id === null
              ? { rows: [] as AgentExecutionRow[] }
              : await client.query<AgentExecutionRow>(
                  `select * from agent_executions where id = $1 for update`,
                  [step.agent_execution_id],
                );
          const execution = executionRows.rows[0];
          if (
            execution !== undefined &&
            (execution.status === "succeeded" || execution.status === "failed")
          ) {
            continue;
          }
          const deadlineKind = workflowDeadlineKind(execution, step, run, now);
          if (deadlineKind === undefined || deadlineKind === "whole_run") continue;
          if (execution === undefined) {
            const reason = deadlineKind === "step_idle" ? "step_idle_timeout" : "step_hard_timeout";
            await client.query(
              `update workflow_step_runs
               set status = 'timed_out', failure_reason = $2, deadline_kind = $3, completed_at = $4
               where id = $1 and status = 'running'`,
              [step.id, reason, deadlineKind, now],
            );
            await client.query(
              `update trigger_runs
               set status = 'failed', deadline_kind = $2, failure_reason = $3, completed_at = $4
               where id = $1 and status = 'running'`,
              [run.id, deadlineKind, reason, now],
            );
            await client.query(`delete from workflow_wakeups where trigger_run_id = $1`, [run.id]);
            recoveries.push({ triggerRunId: run.id, executionIds: [] });
          } else {
            const updated = await timeoutWorkflowStepOnClient(
              client,
              execution,
              step,
              run,
              deadlineKind,
              now,
            );
            recoveries.push({ triggerRunId: run.id, executionIds: [updated.id] });
          }
        }
      }
      await client.query("commit");
      return recoveries;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async updateTriggerRunValues(triggerRunId: string, values: unknown): Promise<TriggerRunRecord> {
    const rows = await this.dependencies.query<TriggerRunRow>(
      this.pool,
      `update trigger_runs set values = $2 where id = $1 returning *`,
      [triggerRunId, values],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new Error(`trigger run not found: ${triggerRunId}`);
    return toTriggerRunRecord(row);
  }

  async listProjectActivityRuns(
    projectId: string,
    limit: number,
  ): Promise<ProjectActivityRunListRecord[]> {
    const rows = await this.dependencies.query<ProjectActivityRunListRow>(
      this.pool,
      `select runs.*, receipts.provider, receipts.connection_id, receipts.resource_id,
              receipts.delivery_id, receipts.signature_hash, receipts.source, receipts.repo,
              receipts.received_at, receipts.dropped_reason
       from trigger_runs runs
       join provider_event_receipts receipts
         on receipts.id = runs.provider_event_receipt_id
        and receipts.organization_id = runs.organization_id
       where runs.project_id = $1
       order by runs.created_at desc, runs.id desc
       limit $2`,
      [projectId, limit],
    );
    return rows.rows.map((row) => this.toProjectActivityRunList(row));
  }

  async findProjectActivityRun(projectId: string, runId: string) {
    const rows = await this.dependencies.query<ProjectActivityRunRow>(
      this.pool,
      `select runs.*, receipts.provider, receipts.connection_id, receipts.resource_id,
              receipts.delivery_id, receipts.signature_hash, receipts.source, receipts.repo,
              receipts.payload, receipts.received_at, receipts.dropped_reason,
              receipts.accepted_routes
       from trigger_runs runs
       join provider_event_receipts receipts
         on receipts.id = runs.provider_event_receipt_id
        and receipts.organization_id = runs.organization_id
       where runs.project_id = $1 and runs.id = $2
       limit 1`,
      [projectId, runId],
    );
    const row = rows.rows[0];
    return row === undefined ? undefined : this.toProjectActivityRun(row);
  }

  private async toProjectActivityRun(
    row: ProjectActivityRunRow,
  ): Promise<ProjectActivityRunRecord> {
    const steps = await this.dependencies.query<WorkflowStepRunRow>(
      this.pool,
      `select * from workflow_step_runs where trigger_run_id = $1 order by ordinal`,
      [row.id],
    );
    return {
      run: toTriggerRunRecord(row),
      receipt: toProviderEventReceiptRecord(row),
      steps: steps.rows.map(toWorkflowStepRunRecord),
    };
  }

  private toProjectActivityRunList(row: ProjectActivityRunListRow): ProjectActivityRunListRecord {
    return {
      run: toTriggerRunRecord(row),
      receipt: toProviderEventReceiptSummary(row),
    };
  }

  async canRefreshStepIdleDeadline(
    client: PoolClient,
    stepRunId: string,
    processedAt: Date,
  ): Promise<boolean> {
    const stepRows = await client.query<WorkflowStepRunRow>(
      `select * from workflow_step_runs where id = $1`,
      [stepRunId],
    );
    const stepCandidate = stepRows.rows[0];
    if (stepCandidate === undefined) return false;

    const runRows = await client.query<TriggerRunRow>(
      `select * from trigger_runs where id = $1 for update`,
      [stepCandidate.trigger_run_id],
    );
    const lockedStepRows = await client.query<WorkflowStepRunRow>(
      `select * from workflow_step_runs where id = $1 for update`,
      [stepCandidate.id],
    );
    const step = lockedStepRows.rows[0];
    const run = runRows.rows[0];
    return (
      step !== undefined &&
      step.status === "running" &&
      run !== undefined &&
      run.status === "running" &&
      (run.deadline_at === null || run.deadline_at > processedAt)
    );
  }

  async updateStepIdleDeadline(
    client: PoolClient,
    stepRunId: string,
    idleDeadlineAt: Date | null,
  ): Promise<void> {
    await client.query(
      `update workflow_step_runs
       set idle_deadline_at = $2
       where id = $1 and status = 'running'`,
      [stepRunId, idleDeadlineAt],
    );
  }
}

interface TriggerRunRow extends QueryResultRow {
  id: string;
  organization_id: string;
  project_id: string;
  configuration_revision_id: string;
  provider_event_receipt_id: string;
  configured_trigger_name: string;
  outcome: TriggerRunRecord["outcome"];
  status: TriggerRunRecord["status"];
  raw_prompt: string;
  prompt: string;
  inputs: unknown;
  values: unknown;
  trigger_context: unknown;
  output_context: unknown;
  deadline_at: Date | null;
  deadline_kind: WorkflowDeadlineKind | null;
  failure_reason: string | null;
  terminal_notification_pending_at: Date | null;
  terminal_notification_delivered_at: Date | null;
  terminal_notification_lease_expires_at: Date | null;
  rejection: unknown;
  created_at: Date;
  completed_at: Date | null;
}

interface ProjectActivityRunRow extends TriggerRunRow {
  provider: ProviderEventReceiptRecord["provider"];
  connection_id: string | null;
  resource_id: string | null;
  delivery_id: string;
  signature_hash: string | null;
  source: string;
  repo: string | null;
  payload: unknown;
  received_at: Date;
  dropped_reason: string | null;
  accepted_routes: unknown;
}

interface ProjectActivityRunListRow extends TriggerRunRow {
  provider: ProviderEventReceiptRecord["provider"];
  connection_id: string | null;
  resource_id: string | null;
  delivery_id: string;
  signature_hash: string | null;
  source: string;
  repo: string | null;
  received_at: Date;
  dropped_reason: string | null;
}

interface WorkflowStepRunRow extends QueryResultRow {
  id: string;
  trigger_run_id: string;
  step_id: string;
  ordinal: number;
  status: WorkflowStepRunRecord["status"];
  agent_execution_id: string | null;
  output: unknown;
  failure_reason: string | null;
  deadline_kind: WorkflowDeadlineKind | null;
  deadline_at: Date | null;
  idle_deadline_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  dispatch_intent: LaunchMachineIntent | null;
}

interface WorkflowWakeupRow extends QueryResultRow {
  trigger_run_id: string;
  available_at: Date;
  lease_expires_at: Date | null;
}

function toTriggerRunRecord(row: TriggerRunRow): TriggerRunRecord {
  const evidence = {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    configurationRevisionId: row.configuration_revision_id,
    providerEventReceiptId: row.provider_event_receipt_id,
    configuredTriggerName: row.configured_trigger_name,
    rawPrompt: row.raw_prompt,
    prompt: row.prompt,
    inputs: parseInvocationInputs(row.inputs),
    values: row.values,
    triggerContext: row.trigger_context,
    outputContext: row.output_context,
    createdAt: row.created_at,
  };
  if (row.outcome === "rejected") {
    if (row.status !== "rejected" || row.rejection === null || row.rejection === undefined) {
      throw new Error(`invalid rejected trigger run ${row.id}`);
    }
    const rejected: RejectedTriggerRunRecord = {
      ...evidence,
      outcome: "rejected",
      status: "rejected",
      rejection: parseInvocationRejection(row.rejection),
      completedAt: row.completed_at ?? row.created_at,
    };
    return rejected;
  }
  if (row.outcome !== "accepted" || row.status === "rejected" || row.rejection !== null) {
    throw new Error(`invalid accepted trigger run ${row.id}`);
  }
  if (row.deadline_at === null) throw new Error(`invalid accepted trigger run ${row.id}`);
  const accepted: AcceptedTriggerRunRecord = {
    ...evidence,
    outcome: "accepted",
    status: row.status,
    deadlineAt: row.deadline_at,
    deadlineKind: row.deadline_kind,
    failureReason: row.failure_reason,
    terminalNotificationPendingAt: row.terminal_notification_pending_at,
    terminalNotificationDeliveredAt: row.terminal_notification_delivered_at,
    terminalNotificationLeaseExpiresAt: row.terminal_notification_lease_expires_at,
    completedAt: row.completed_at,
  };
  return accepted;
}

function toWorkflowStepRunRecord(row: WorkflowStepRunRow): WorkflowStepRunRecord {
  return {
    id: row.id,
    triggerRunId: row.trigger_run_id,
    stepId: row.step_id,
    ordinal: row.ordinal,
    status: row.status,
    agentExecutionId: row.agent_execution_id,
    output: row.output,
    failureReason: row.failure_reason,
    deadlineKind: row.deadline_kind,
    deadlineAt: row.deadline_at,
    idleDeadlineAt: row.idle_deadline_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    dispatchIntent: row.dispatch_intent,
  };
}

function toWorkflowWakeupRecord(
  row: WorkflowWakeupRow,
  leasedBeforeClaim = false,
): WorkflowWakeupRecord {
  return {
    triggerRunId: row.trigger_run_id,
    availableAt: row.available_at,
    leaseExpiresAt: row.lease_expires_at,
    leasedBeforeClaim,
  };
}
interface OrganizationUsageRow extends QueryResultRow {
  used: number | string;
}

function deadlineConditionAllows(
  execution: AgentExecutionRow,
  condition: WorkflowAgentCompletionInput["deadlineCondition"],
): boolean {
  if (condition === undefined) return true;
  const current = condition.kind === "hard" ? execution.deadline_at : execution.idle_deadline_at;
  return (
    current !== null &&
    current.getTime() === condition.deadlineAt.getTime() &&
    current.getTime() <= condition.observedAt.getTime()
  );
}

function workflowDeadlineKind(
  execution: AgentExecutionRow | undefined,
  step: WorkflowStepRunRow,
  run: TriggerRunRow,
  observedAt: Date,
): WorkflowDeadlineKind | undefined {
  if (run.status === "running" && run.deadline_at !== null && run.deadline_at <= observedAt) {
    return "whole_run";
  }
  const hardDeadline = execution?.deadline_at ?? step.deadline_at;
  const idleDeadline = execution?.idle_deadline_at ?? step.idle_deadline_at;
  if (hardDeadline !== null && hardDeadline <= observedAt) {
    if (idleDeadline !== null && idleDeadline <= observedAt && idleDeadline < hardDeadline) {
      return "step_idle";
    }
    return "step_hard";
  }
  if (idleDeadline !== null && idleDeadline <= observedAt) return "step_idle";
  return undefined;
}

async function timeoutWorkflowStepOnClient(
  client: PoolClient,
  execution: AgentExecutionRow,
  step: WorkflowStepRunRow,
  run: TriggerRunRow,
  deadlineKind: Exclude<WorkflowDeadlineKind, "whole_run">,
  observedAt: Date,
): Promise<AgentExecutionRow> {
  const reason = deadlineKind === "step_idle" ? "step_idle_timeout" : "step_hard_timeout";
  const updatedExecution = await client.query<AgentExecutionRow>(
    `update agent_executions
     set status = 'failed', completed_at = $2,
         result = jsonb_build_object('status', 'failed', 'reason', $3::text),
         idle_deadline_at = null,
         hub_action = case
           when daemon_id is null then null
           when coalesce((launch_intent ->> 'autoArchive')::boolean, false) then 'archive'
           else 'interrupt'
         end,
         hub_action_completed_at = null::timestamptz
     where id = $1 and status in ('spawning', 'running')
     returning *`,
    [execution.id, observedAt, reason],
  );
  const updated = updatedExecution.rows[0] ?? execution;
  await client.query(
    `update workflow_step_runs
     set status = 'timed_out', failure_reason = $2, deadline_kind = $3, completed_at = $4
     where id = $1 and status in ('pending', 'running')`,
    [step.id, reason, deadlineKind, observedAt],
  );
  if (run.status === "running") {
    await client.query(
      `update trigger_runs
       set status = 'failed', deadline_kind = $2, failure_reason = $3, completed_at = $4,
           terminal_notification_pending_at = coalesce(terminal_notification_pending_at, $4),
           terminal_notification_lease_expires_at = null
       where id = $1 and status = 'running'`,
      [run.id, deadlineKind, reason, observedAt],
    );
  }
  await client.query(`delete from workflow_wakeups where trigger_run_id = $1`, [run.id]);
  return updated;
}

async function timeoutWorkflowRunOnClient(
  client: PoolClient,
  run: TriggerRunRow,
  observedAt: Date,
): Promise<WorkflowDeadlineRecovery> {
  const executionRows = await client.query<{ id: string }>(
    `update agent_executions
     set status = 'failed', completed_at = $2,
         result = jsonb_build_object('status', 'failed', 'reason', 'whole_run_timeout'),
         idle_deadline_at = null,
         hub_action = case
           when daemon_id is null then null
           when coalesce((launch_intent ->> 'autoArchive')::boolean, false) then 'archive'
           else 'interrupt'
         end,
         hub_action_completed_at = null::timestamptz
     where workflow_step_run_id in (
       select id from workflow_step_runs where trigger_run_id = $1
     )
       and status in ('spawning', 'running')
     returning id`,
    [run.id, observedAt],
  );
  await client.query(
    `update workflow_step_runs
     set status = 'timed_out', failure_reason = 'whole_run_timeout',
         deadline_kind = 'whole_run', completed_at = $2
     where trigger_run_id = $1 and status in ('pending', 'running')`,
    [run.id, observedAt],
  );
  await client.query(
    `update trigger_runs
     set status = 'timed_out', deadline_kind = 'whole_run',
         failure_reason = 'whole_run_timeout', completed_at = $2,
         terminal_notification_pending_at = coalesce(terminal_notification_pending_at, $2),
         terminal_notification_lease_expires_at = null
     where id = $1 and status = 'running'`,
    [run.id, observedAt],
  );
  await client.query(`delete from workflow_wakeups where trigger_run_id = $1`, [run.id]);
  return {
    triggerRunId: run.id,
    executionIds: executionRows.rows.map((row) => row.id),
  };
}

async function transitionWorkflowAgentExecution(
  client: PoolClient,
  execution: AgentExecutionRow,
  input: WorkflowAgentCompletionInput,
): Promise<{ execution: AgentExecutionRow; transitioned: boolean } | undefined> {
  if (execution.status !== "spawning" && execution.status !== "running") {
    return { execution, transitioned: false };
  }
  if (!deadlineConditionAllows(execution, input.deadlineCondition)) return undefined;

  const completedAt = input.observedAt ?? new Date();
  const updatedRows = await client.query<AgentExecutionRow>(
    `update agent_executions
     set status = $2, completed_at = $3,
         completed_by_agent_at = case
           when $4::boolean and $2 = 'succeeded'::agent_execution_status then $3
           else completed_by_agent_at
         end,
         result = case when $5::boolean then $6 else result end,
         idle_deadline_at = null,
         hub_action = case when $7::boolean then $8 else hub_action end,
         hub_action_completed_at = case
           when $7::boolean and $8::text is null then $3
           when $7::boolean then null
           else hub_action_completed_at
         end
     where id = $1 and status in ('spawning', 'running')
     returning *`,
    [
      input.executionId,
      input.executionStatus,
      completedAt,
      input.completedByAgent === true,
      input.result !== undefined,
      input.result ?? null,
      input.hubAction !== undefined,
      input.hubAction ?? null,
    ],
  );
  return {
    execution: updatedRows.rows[0] ?? execution,
    transitioned: updatedRows.rows.length === 1,
  };
}

async function finishWorkflowStepAndRun(
  client: PoolClient,
  step: WorkflowStepRunRow,
  run: TriggerRunRow,
  input: WorkflowAgentCompletionInput,
): Promise<void> {
  if (isTerminalWorkflowStepStatus(step.status)) return;

  const completedAt = input.observedAt ?? new Date();
  await client.query(
    `update workflow_step_runs
     set status = $2, output = $3, failure_reason = $4,
         deadline_kind = coalesce($6, deadline_kind), completed_at = $5
     where id = $1`,
    [
      step.id,
      input.stepStatus,
      input.stepOutput !== undefined ? input.stepOutput : (input.result ?? null),
      input.failureReason ?? null,
      completedAt,
      input.deadlineKind ?? null,
    ],
  );
  if (input.stepStatus === "succeeded") {
    if (run.status === "running") await wakeWorkflowRun(client, step.trigger_run_id, completedAt);
    return;
  }
  if (run.status === "running") {
    await client.query(
      `update trigger_runs
       set status = case
             when $5 = 'whole_run' then 'timed_out'
             when $5 is null then $2
             else 'failed'
           end,
           deadline_kind = coalesce($5, deadline_kind), failure_reason = $3, completed_at = $4,
           terminal_notification_pending_at = coalesce(terminal_notification_pending_at, $4),
           terminal_notification_lease_expires_at = null
       where id = $1`,
      [
        step.trigger_run_id,
        input.stepStatus,
        input.failureReason ?? null,
        completedAt,
        input.deadlineKind ?? null,
      ],
    );
  }
  await client.query(`delete from workflow_wakeups where trigger_run_id = $1`, [
    step.trigger_run_id,
  ]);
}

async function findTriggerRunOnClient(
  client: PoolClient,
  triggerRunId: string,
): Promise<TriggerRunRecord | undefined> {
  const rows = await client.query<TriggerRunRow>(`select * from trigger_runs where id = $1`, [
    triggerRunId,
  ]);
  return rows.rows[0] === undefined ? undefined : toTriggerRunRecord(rows.rows[0]);
}

async function findAgentExecutionOnClient(
  client: PoolClient,
  executionId: string,
): Promise<AgentExecutionRecord | undefined> {
  const rows = await client.query<AgentExecutionRow>(
    `select * from agent_executions where id = $1`,
    [executionId],
  );
  return rows.rows[0] === undefined ? undefined : toAgentExecutionRecord(rows.rows[0]);
}

async function wakeWorkflowRun(
  client: PoolClient,
  triggerRunId: string,
  availableAt: Date,
): Promise<void> {
  await client.query(
    `insert into workflow_wakeups (trigger_run_id, available_at, lease_expires_at)
     values ($1, $2, null)
     on conflict (trigger_run_id) do update
     set available_at = least(workflow_wakeups.available_at, excluded.available_at),
         lease_expires_at = null`,
    [triggerRunId, availableAt],
  );
}

function isTerminalWorkflowStepStatus(status: WorkflowStepRunRow["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "timed_out";
}
