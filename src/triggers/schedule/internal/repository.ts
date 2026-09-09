import { randomUUID } from "node:crypto";
import type { DatabaseRuntime, QueryHandle, QueryRow } from "../../../db/runtime/index.js";
import { acceptWorkflowRun } from "../../../db/workflow-intake.js";
import { parseCompiledHubConfig } from "../../../config/compiler.js";
import { RecurrenceSchema, nextOccurrence, type Recurrence } from "../recurrence.js";
import type { ScheduleStore } from "../index.js";

interface DueSchedule extends QueryRow {
  trigger_id: string;
  organization_id: string;
  runtime_project_id: string;
  configuration_revision_id: string;
  normalized_configuration: unknown;
  recurrence: unknown;
  next_at: Date;
  active_run_id: string | null;
}

export class ScheduleRepository implements ScheduleStore {
  constructor(private readonly runtime: DatabaseRuntime) {}

  /** Called by trigger save while it holds the trigger row lock. */
  static async synchronize(
    transaction: QueryHandle,
    triggerId: string,
    recurrence: Recurrence | undefined,
    now: Date,
  ): Promise<void> {
    if (recurrence === undefined) {
      await transaction.query(
        "update trigger_schedules set recurrence = null, next_at = null where trigger_id = $1",
        [triggerId],
      );
      return;
    }
    await transaction.query(
      `insert into trigger_schedules (trigger_id, recurrence, next_at)
      values ($1, $2, $3) on conflict (trigger_id) do update
      set recurrence = excluded.recurrence,
          next_at = case when trigger_schedules.recurrence = excluded.recurrence then trigger_schedules.next_at else excluded.next_at end`,
      [triggerId, recurrence, nextOccurrence(recurrence, now)],
    );
  }

  async tick(now: Date): Promise<number> {
    // Lock the same owning trigger row as save, so disable/edit and occurrence acceptance serialize.
    // Limit each transaction; other processes can take the remaining unlocked triggers.
    return this.runtime.transaction(async (transaction) => {
      const due = await transaction.query<DueSchedule>(
        `select s.trigger_id, t.organization_id, t.runtime_project_id,
          p.active_configuration_revision_id as configuration_revision_id, r.normalized_configuration,
          s.recurrence, s.next_at, s.active_run_id
        from trigger_schedules s
        join organization_triggers t on t.id = s.trigger_id
        join projects p on p.id = t.runtime_project_id
        join project_configuration_revisions r on r.id = p.active_configuration_revision_id
        where t.enabled and s.next_at <= $1
        order by s.next_at, s.trigger_id
        for update of t, s skip locked limit 100`,
        [now],
      );
      let created = 0;
      for (const schedule of due.rows) {
        const recurrence = RecurrenceSchema.parse(schedule.recurrence);
        const active =
          schedule.active_run_id === null
            ? undefined
            : (
                await transaction.query<{ status: string }>(
                  "select status from trigger_runs where id = $1",
                  [schedule.active_run_id],
                )
              ).rows[0];
        let runId = schedule.active_run_id;
        if (active?.status !== "running") {
          runId = await enqueueOccurrence(transaction, schedule, now);
          created++;
        }
        await transaction.query(
          "update trigger_schedules set next_at = $2, active_run_id = $3 where trigger_id = $1",
          [schedule.trigger_id, nextOccurrence(recurrence, now), runId],
        );
      }
      return created;
    });
  }
}

async function enqueueOccurrence(
  transaction: QueryHandle,
  schedule: DueSchedule,
  now: Date,
): Promise<string> {
  const configuration = parseCompiledHubConfig(schedule.normalized_configuration);
  const trigger = configuration.triggers.find(({ on }) => on === "schedule.tick");
  if (trigger === undefined) throw new Error("Scheduled trigger configuration is missing.");
  const occurrence = schedule.next_at.toISOString();
  const deliveryId = `schedule:${schedule.trigger_id}:${occurrence}`;
  const receiptId = randomUUID();
  const event = {
    schedule: {
      trigger_id: schedule.trigger_id,
      scheduled_at: occurrence,
      timezone: RecurrenceSchema.parse(schedule.recurrence).timezone,
    },
  };
  const context = { provider: "schedule", deliveryId, event };
  await transaction.query(
    `insert into provider_event_receipts
    (id, organization_id, provider, delivery_id, source, payload, received_at, accepted_routes)
    values ($1, $2, 'schedule', $3, 'schedule.tick', $4, $5, $6)`,
    [
      receiptId,
      schedule.organization_id,
      deliveryId,
      event,
      now,
      JSON.stringify([
        {
          projectId: schedule.runtime_project_id,
          configurationRevisionId: schedule.configuration_revision_id,
          connectionId: null,
          resourceId: null,
        },
      ]),
    ],
  );
  const accepted = await acceptWorkflowRun(transaction, {
    organizationId: schedule.organization_id,
    projectId: schedule.runtime_project_id,
    configurationRevisionId: schedule.configuration_revision_id,
    providerEventReceiptId: receiptId,
    configuredTriggerName: trigger.name,
    prompt: "",
    inputs: {},
    triggerContext: context,
    outputContext: { provider: "schedule" },
    conversation: null,
    deadlineAt: new Date(now.getTime() + trigger.maxRuntimeMs),
    stepIds: trigger.steps.map(({ id }) => id),
    createdAt: now,
  });
  return accepted.id;
}
