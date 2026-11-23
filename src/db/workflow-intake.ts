import type { QueryHandle } from "./runtime/index.js";
import type { CreateAcceptedTriggerRunInput } from "./types.js";

/** Atomically accept work inside the caller’s transaction, including durable steps and wakeup. */
export async function acceptWorkflowRun(client: QueryHandle, input: CreateAcceptedTriggerRunInput) {
  const inserted = await client.query<{ id: string; outcome: string }>(
    `insert into trigger_runs
           (id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
           configured_trigger_name, outcome, status,
            prompt, inputs, values, trigger_context, output_context, deadline_at, deadline_kind, rejection, created_at, conversation)
         values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, 'accepted', 'running', $7, $8, '{}'::jsonb, $9, $10, $11, null, null, $12, $13)
         on conflict (provider_event_receipt_id, project_id, configured_trigger_name) do nothing
         returning *`,
    [
      input.id ?? null,
      input.organizationId,
      input.projectId,
      input.configurationRevisionId,
      input.providerEventReceiptId,
      input.configuredTriggerName,
      input.prompt,
      input.inputs,
      input.triggerContext,
      input.outputContext,
      input.deadlineAt,
      input.createdAt ?? new Date(),
      input.conversation ?? null,
    ],
  );
  let run = inserted.rows[0];
  const created = run !== undefined;
  if (run === undefined) {
    const existing = await client.query<{ id: string; outcome: string }>(
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
  return { id: run.id, created };
}
