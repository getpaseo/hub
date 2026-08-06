import { createHash, randomBytes } from "node:crypto";
import { configurationValidationIssues } from "../configuration/validation-errors.js";
import { parseDeploymentDocument } from "../configuration/deployment-document.js";
import type { DaemonClock } from "../daemons/index.js";
import { DaemonDispatchFailure } from "../daemons/index.js";
import { ENROLLMENT_LIFETIME_MS } from "../daemons/registration.js";
import { isDatabaseUnavailableError } from "../db/errors.js";
import { formatInvocationRejection } from "../triggers/invocation.js";
import { ManualRunRejected } from "../triggers/manual/provider.js";
import type {
  DispatchManualRunInput,
  DispatchManualRunResult,
  PublicOperationCapabilities,
  PublicOperationRepository,
  PublicOperations,
} from "./types.js";

export type * from "./types.js";

export function createPublicOperations(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
  clock: DaemonClock = { nowDate: () => new Date() },
): PublicOperations {
  return {
    async installConfiguration(authorization, input) {
      try {
        const project = await repository.findActiveProject(
          authorization.organizationId,
          input.projectSlug,
        );
        if (project === undefined) return { status: "project_not_found" };
        const document = parseDeploymentDocument(input.yaml);
        if (!document.success) {
          return { status: document.kind, issues: document.issues };
        }
        const configuration = capabilities.configurationForProject(project.id);
        const record = await configuration.insertManualRevision({
          rawYaml: input.yaml,
          rawConfiguration: document.configuration,
          userId: null,
          sourceEvidence: { kind: "api-key", keyId: authorization.keyId },
        });
        if (record.validationErrors !== null) {
          return {
            status: "invalid_configuration",
            versionId: record.id,
            issues: configurationValidationIssues(record.validationErrors),
          };
        }
        const promoted = await configuration.activate(record.id);
        return {
          status: "installed",
          projectSlug: project.slug,
          versionId: promoted.revision.id,
          version: promoted.revision.version,
          active: true,
        };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async dispatchManualRun(authorization, input) {
      try {
        const project = await repository.findActiveProject(
          authorization.organizationId,
          input.projectSlug,
        );
        if (project === undefined) return { status: "project_not_found" };
        let result: DispatchManualRunResult;
        try {
          result = await dispatchManualRun(
            repository,
            capabilities,
            authorization,
            project.id,
            input,
            internalDeliveryId(authorization.organizationId, project.id, input.deliveryKey),
          );
        } catch (error) {
          if (error instanceof ManualRunRejected) result = { status: error.code };
          else if (
            error instanceof DaemonDispatchFailure &&
            error.reason === "daemon_unreachable"
          ) {
            result = { status: "daemon_offline" };
          } else throw error;
        }
        return result;
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async issueEnrollmentToken(authorization) {
      try {
        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(clock.nowDate().getTime() + ENROLLMENT_LIFETIME_MS);
        const outcome = await repository.issueEnrollmentToken(authorization, { token, expiresAt });
        return outcome === "issued" ? { status: "issued", token, expiresAt } : { status: outcome };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
  };
}

async function dispatchManualRun(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
  authorization: { organizationId: string; keyId: string },
  projectId: string,
  input: DispatchManualRunInput,
  deliveryId: string,
): Promise<DispatchManualRunResult> {
  const outcome = await capabilities.dispatchManualEvent({
    organizationId: authorization.organizationId,
    projectId,
    source: "manual.run",
    deliveryId,
    receivedAt: new Date(),
    payload: {
      ...(input.expectedVersionId === undefined
        ? {}
        : { expectedVersionId: input.expectedVersionId }),
      trigger: input.trigger,
      actor: input.actor,
      input: input.input,
      publicDeliveryKey: input.deliveryKey,
      authenticatedBy: { kind: "api-key", keyId: authorization.keyId },
    },
  });
  const providerEventReceiptId = outcome?.providerEventReceiptId;
  if (providerEventReceiptId === undefined) return { status: "dispatch_conflict" };
  const run = await repository.findManualRun(providerEventReceiptId, input.trigger);
  if (run === undefined) return { status: "dispatch_conflict" };
  if (run.outcome === "rejected") {
    return {
      status: "invalid_input",
      providerEventReceiptId,
      triggerRunId: run.id,
      configuredTriggerName: run.configuredTriggerName,
      issues: [{ path: ["input"], message: formatInvocationRejection(run.rejection) }],
    };
  }
  return {
    status: "dispatched",
    deliveryKey: input.deliveryKey,
    providerEventReceiptId,
    triggerRunId: run.id,
    configuredTriggerName: run.configuredTriggerName,
    workflowStatus: run.status,
  };
}

function internalDeliveryId(
  organizationId: string,
  projectId: string,
  deliveryKey: string,
): string {
  return `public-manual-${createHash("sha256")
    .update([organizationId, projectId, deliveryKey].map((part) => JSON.stringify(part)).join(":"))
    .digest("base64url")}`;
}

function storageUnavailableOrThrow(error: unknown): { status: "infrastructure_unavailable" } {
  if (isDatabaseUnavailableError(error)) return { status: "infrastructure_unavailable" };
  throw error;
}
