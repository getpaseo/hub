import type { ApiKeyScope } from "../auth/api-key-contract.js";
import type { ResolvedPromptPartials } from "../config/prompt-partials.js";
import type { TriggerRunRecord } from "../db/types.js";

export interface PublicAuthorization {
  keyId: string;
  organizationId: string;
  scopes: readonly ApiKeyScope[];
}

export interface InstallConfigurationInput {
  projectSlug: string;
  yaml: string;
  partials?: readonly InstallConfigurationPartial[] | undefined;
}

export interface InstallConfigurationPartial {
  path: string;
  content: string;
}

export type InstallConfigurationResult =
  | {
      status: "installed";
      projectSlug: string;
      versionId: string;
      version: number;
      active: true;
    }
  | { status: "project_not_found" }
  | { status: "invalid_yaml"; issues: readonly DomainIssue[] }
  | { status: "invalid_document"; issues: readonly DomainIssue[] }
  | { status: "invalid_bundle"; issues: readonly DomainIssue[] }
  | {
      status: "invalid_configuration";
      versionId: string;
      issues: readonly DomainIssue[];
    }
  | InfrastructureUnavailable;

export interface DispatchManualRunInput {
  projectSlug: string;
  expectedVersionId?: string | undefined;
  trigger: string;
  actor: string;
  deliveryKey: string;
  input: unknown;
}

export type DispatchManualRunResult =
  | {
      status: "dispatched";
      deliveryKey: string;
      providerEventReceiptId: string;
      triggerRunId: string;
      configuredTriggerName: string;
      workflowStatus: "running" | "succeeded" | "failed" | "timed_out";
    }
  | { status: "project_not_found" }
  | { status: "actor_forbidden" }
  | { status: "daemon_offline" }
  | { status: "expected_configuration_not_current" }
  | { status: "configuration_not_found" }
  | { status: "trigger_not_found" }
  | {
      status: "invalid_input";
      providerEventReceiptId: string;
      triggerRunId: string;
      configuredTriggerName: string;
      issues: readonly DomainIssue[];
    }
  | { status: "dispatch_conflict" }
  | InfrastructureUnavailable;

export type IssueEnrollmentTokenResult =
  | { status: "issued"; token: string; expiresAt: Date }
  | { status: "credential_revoked" }
  | InfrastructureUnavailable;

export interface DomainIssue {
  path: readonly (string | number)[];
  message: string;
}

export interface InfrastructureUnavailable {
  status: "infrastructure_unavailable";
}

export interface PublicOperations {
  installConfiguration(
    authorization: PublicAuthorization,
    input: InstallConfigurationInput,
  ): Promise<InstallConfigurationResult>;
  dispatchManualRun(
    authorization: PublicAuthorization,
    input: DispatchManualRunInput,
  ): Promise<DispatchManualRunResult>;
  issueEnrollmentToken(authorization: PublicAuthorization): Promise<IssueEnrollmentTokenResult>;
}

export interface PublicOperationRepository {
  findActiveProject(
    organizationId: string,
    projectSlug: string,
  ): Promise<{ id: string; slug: string } | undefined>;
  findManualRun(
    providerEventReceiptId: string,
    trigger: string,
  ): Promise<TriggerRunRecord | undefined>;
  issueEnrollmentToken(
    authorization: PublicAuthorization,
    input: { token: string; expiresAt: Date },
  ): Promise<"issued" | "credential_revoked" | "infrastructure_unavailable">;
}

export interface PublicOperationCapabilities {
  configurationForProject(projectId: string): {
    insertManualRevision(input: {
      rawYaml: string;
      rawConfiguration: unknown;
      userId: null;
      sourceEvidence: { kind: "api-key"; keyId: string };
      resolvedPromptPartials?: ResolvedPromptPartials;
    }): Promise<{ id: string; validationErrors: unknown }>;
    activate(id: string): Promise<{ revision: { id: string; version: number } }>;
  };
  dispatchManualEvent(input: {
    organizationId: string;
    projectId: string;
    source: "manual.run";
    deliveryId: string;
    receivedAt: Date;
    payload: unknown;
  }): Promise<{ providerEventReceiptId: string } | void>;
}
