import type {
  AgentExecutionRow,
  AttachmentRow,
  MachineRow,
  ProjectConfigurationRevisionRow,
  ProjectRow,
  ProviderEventReceiptRow,
} from "./pg.js";
import type {
  AgentExecutionHubAcknowledgements,
  AgentExecutionRecord,
  AttachmentRecord,
  MachineRecord,
  ProjectConfigurationRevisionRecord,
  ProjectRecord,
  ProviderEventReceiptRecord,
} from "./types.js";

export function toProviderEventReceiptRecord(
  row: ProviderEventReceiptRow,
): ProviderEventReceiptRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    connectionId: row.connection_id,
    resourceId: row.resource_id,
    deliveryId: row.delivery_id,
    signatureHash: row.signature_hash,
    source: row.source,
    repo: row.repo,
    payload: row.payload,
    receivedAt: row.received_at,
    droppedReason: row.dropped_reason,
  };
}

export function toMachineRecord(row: MachineRow): MachineRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    source: row.source,
    status: row.status,
    startedAt: row.started_at,
    terminatedAt: row.terminated_at,
    shutdownReason: row.shutdown_reason,
    triggerName: row.trigger_name,
    triggerContext: row.trigger_context,
    specs: row.specs,
  };
}

export function toAgentExecutionRecord(row: AgentExecutionRow): AgentExecutionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    machineId: row.machine_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    completedByAgentAt: row.completed_by_agent_at,
    deadlineAt: row.deadline_at,
    idleDeadlineAt: row.idle_deadline_at,
    result: row.result,
    triggerContext: row.trigger_context,
    outputContext: row.output_context,
    configurationRevisionId: row.configuration_revision_id,
    completionTokenHash: row.completion_token_hash,
    replyClaimedAt: row.reply_claimed_at,
    replyClaimCount: row.reply_claim_count,
    launchIntent: row.launch_intent,
    daemonId: row.daemon_id,
    daemonAgentId: row.daemon_agent_id,
    workflowStepRunId: row.workflow_step_run_id,
    hubAction: row.hub_action,
    hubActionCompletedAt: row.hub_action_completed_at,
    hubActionReadyAt: row.hub_action_ready_at,
    hubActionAcknowledgements: toAgentExecutionHubAcknowledgements(row.hub_action_acknowledgements),
  };
}

function toAgentExecutionHubAcknowledgements(value: unknown): AgentExecutionHubAcknowledgements {
  if (!isRecord(value)) return emptyAgentExecutionHubAcknowledgements();
  const terminalAt = toDateOrNull(value["terminal_at"]);
  const idleAt = toDateOrNull(value["idle_at"]);
  const rawFinishExecutionCall = value["finish_execution_call"];
  let finishExecutionCall: AgentExecutionHubAcknowledgements["finishExecutionCall"] = null;
  if (isRecord(rawFinishExecutionCall)) {
    const callId = rawFinishExecutionCall["call_id"];
    const status = rawFinishExecutionCall["status"];
    const observedAt = toDateOrNull(rawFinishExecutionCall["observed_at"]);
    if (
      typeof callId === "string" &&
      (status === "running" ||
        status === "completed" ||
        status === "failed" ||
        status === "canceled") &&
      observedAt !== null
    ) {
      finishExecutionCall = { callId, status, observedAt };
    }
  }
  return { terminalAt, idleAt, finishExecutionCall };
}

function emptyAgentExecutionHubAcknowledgements(): AgentExecutionHubAcknowledgements {
  return { terminalAt: null, idleAt: null, finishExecutionCall: null };
}

function toDateOrNull(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toAttachmentRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    providerEventReceiptId: row.provider_event_receipt_id,
    organizationId: row.organization_id,
    connectionId: row.connection_id,
    provider: row.provider,
    sourceId: row.source_id,
    locator: row.locator,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    createdAt: row.created_at,
  };
}

export function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    activeConfigurationRevisionId: row.active_configuration_revision_id,
  };
}

export function toProjectConfigurationRevisionRecord(
  row: ProjectConfigurationRevisionRow,
): ProjectConfigurationRevisionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    organizationId: row.organization_id,
    version: row.version,
    sourceKind: row.source_kind,
    sourceEvidence: row.source_evidence,
    rawYaml: row.raw_yaml,
    normalizedConfiguration: row.normalized_configuration,
    validationErrors: row.validation_errors,
    contentHash: row.content_hash,
    createdByUserId: row.created_by_user_id,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    validatedAt: row.validated_at,
  };
}
