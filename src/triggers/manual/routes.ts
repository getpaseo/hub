import { z } from "zod";
import type { OperationAuthorization } from "../../auth/api-keys.js";
import type { Database } from "../../db/types.js";
import type { TriggerSource } from "../index.js";
import { dispatchManualTrigger } from "./source.js";

const ManualRunRequestSchema = z
  .object({
    projectSlug: z.string().min(1),
    expectedVersionId: z.string().uuid().optional(),
    trigger: z.string().min(1),
    actor: z.string().min(1),
    deliveryKey: z.string().min(1),
    input: z.unknown(),
  })
  .strict();

export async function runManualTrigger(
  request: Request,
  source: TriggerSource,
  database: Database,
  authorization: OperationAuthorization,
): Promise<Response> {
  const body = ManualRunRequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  const project = await database.findProjectBySlugForOrganization(
    authorization.organizationId,
    body.data.projectSlug,
  );
  if (project === undefined || project.status !== "active") {
    return Response.json({ error: "project_not_found" }, { status: 404 });
  }
  let triggerId: string | undefined;
  try {
    const outcome = await dispatchManualTrigger(source, {
      organizationId: authorization.organizationId,
      projectId: project.id,
      source: "manual.run",
      deliveryId: body.data.deliveryKey,
      receivedAt: new Date(),
      payload: {
        ...(body.data.expectedVersionId === undefined
          ? {}
          : { expectedVersionId: body.data.expectedVersionId }),
        trigger: body.data.trigger,
        actor: body.data.actor,
        input: body.data.input,
        authenticatedBy: { kind: "api-key", keyId: authorization.keyId },
      },
    });
    triggerId = outcome?.triggerId;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "manual_run_failed";
    if (reason.includes("manual_actor_forbidden"))
      return Response.json({ error: "actor_forbidden" }, { status: 403 });
    if (reason.includes("daemon_unreachable"))
      return Response.json({ error: "daemon_offline" }, { status: 409 });
    if (reason.includes("expected_config_version_not_current")) {
      return Response.json({ error: "expected_config_version_not_current" }, { status: 409 });
    }
    if (reason.includes("manual_config_not_found") || reason.includes("manual_trigger_not_found")) {
      return Response.json({ error: reason }, { status: 404 });
    }
    throw error;
  }
  if (triggerId === undefined)
    return Response.json({ error: "manual_run_not_dispatched" }, { status: 409 });
  const run = (await database.findTriggerRunsByTriggerId(triggerId))[0];
  if (!run) return Response.json({ error: "manual_run_not_enqueued" }, { status: 409 });
  return Response.json(
    {
      deliveryKey: body.data.deliveryKey,
      triggerId,
      triggerRunId: run.id,
      configuredTriggerName: run.configuredTriggerName,
      workflowStatus: run.status,
    },
    { status: 200 },
  );
}
