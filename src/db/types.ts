import type { AgentExecutionStatus, MachineSource, MachineStatus } from "./schema.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { InvocationRejection } from "../triggers/invocation.js";

export type WorkflowDeadlineKind = "step_hard" | "step_idle" | "whole_run";

export interface ProviderEventReceiptRecord {
  id: string;
  organizationId: string;
  provider: "github" | "slack" | "discord" | "manual";
  connectionId: string | null;
  resourceId: string | null;
  deliveryId: string;
  signatureHash: string | null;
  source: string;
  repo: string | null;
  payload: unknown;
  receivedAt: Date;
  droppedReason: string | null;
  acceptedRoutes: readonly ProviderEventRouteSnapshot[] | null;
}

export interface ProviderEventReceiptSummary {
  id: string;
  organizationId: string;
  provider: ProviderEventReceiptRecord["provider"];
  connectionId: string | null;
  resourceId: string | null;
  deliveryId: string;
  signatureHash: string | null;
  source: string;
  repo: string | null;
  receivedAt: Date;
  droppedReason: string | null;
}

export interface ProviderEventRouteSnapshot {
  projectId: string;
  configurationRevisionId: string;
  connectionId: string | null;
  resourceId: string | null;
}

export type AttachmentProvider = "slack" | "discord";

export interface AttachmentRecord {
  id: string;
  providerEventReceiptId: string;
  organizationId: string;
  connectionId: string;
  provider: AttachmentProvider;
  sourceId: string;
  locator: unknown;
  filename: string;
  contentType: string | null;
  byteSize: number | null;
  createdAt: Date;
}

export interface InsertAttachmentInput {
  providerEventReceiptId: string;
  organizationId: string;
  connectionId: string;
  provider: AttachmentProvider;
  sourceId: string;
  locator: unknown;
  filename: string;
  contentType?: string | null;
  byteSize?: number | null;
}

export interface MachineRecord {
  id: string;
  orgId: string;
  source: MachineSource;
  status: MachineStatus;
  startedAt: Date;
  terminatedAt: Date | null;
  shutdownReason: string | null;
  triggerName: string | null;
  triggerContext: unknown;
  specs: unknown;
}

export interface AgentExecutionRecord {
  id: string;
  organizationId: string;
  projectId: string;
  machineId: string | null;
  status: AgentExecutionStatus;
  startedAt: Date;
  completedAt: Date | null;
  completedByAgentAt: Date | null;
  deadlineAt: Date | null;
  idleDeadlineAt: Date | null;
  result: unknown;
  triggerContext: unknown;
  outputContext: unknown;
  configurationRevisionId: string;
  completionTokenHash: string | null;
  replyClaimedAt: Date | null;
  replyClaimCount: number;
  outputEmissions: Readonly<Record<string, number>>;
  outputDeliveryAttempts: Readonly<Record<string, AgentExecutionOutputAttempt>>;
  launchIntent: LaunchMachineIntent | null;
  daemonId: string | null;
  daemonAgentId: string | null;
  workflowStepRunId: string | null;
  hubAction: HubAction | null;
  hubActionCompletedAt: Date | null;
  hubActionReadyAt: Date | null;
  hubActionAcknowledgements: AgentExecutionHubAcknowledgements;
}

export type AgentExecutionOutputAttemptStatus = "pending" | "succeeded" | "failed";

export interface AgentExecutionOutputAttempt {
  id: string;
  outputType: string;
  status: AgentExecutionOutputAttemptStatus;
  startedAt: Date;
  leaseExpiresAt: Date;
  completedAt: Date | null;
}

export type HubAction = "interrupt" | "archive";

export type AgentExecutionHubFinishExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export interface AgentExecutionHubFinishExecutionAcknowledgement {
  callId: string | null;
  status: AgentExecutionHubFinishExecutionStatus;
  observedAt: Date;
}

export interface AgentExecutionHubAcknowledgements {
  terminalAt: Date | null;
  idleAt: Date | null;
  finishExecutionCall: AgentExecutionHubFinishExecutionAcknowledgement | null;
}

export type AgentExecutionHubAcknowledgementInput =
  | { kind: "terminal"; observedAt: Date }
  | { kind: "idle"; observedAt: Date }
  | {
      kind: "finish_execution";
      callId?: string | null;
      status: AgentExecutionHubFinishExecutionStatus;
      observedAt: Date;
    };

export interface DaemonRecord {
  id: string;
  slug: string;
  machineId: string;
  serverId: string;
  daemonPublicKey: string;
  credentialVerifier: string;
  scopes: string[];
  approvedByUserId: string | null;
  registeredByApiKeyId: string | null;
  registrationMethod: "operator" | "device";
  status: "active" | "revoked";
  presence: "offline" | "connected";
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface DaemonSlugConflict {
  status: "slug_conflict";
  slug: string;
}

export type DaemonWriteResult = DaemonRecord | DaemonSlugConflict | undefined;

export interface EnrollmentTokenRecord {
  id: string;
  verifier: string;
  organizationId: string;
  authorizationId?: string | null;
  slug?: string | null;
  approvedByUserId?: string | null;
  issuedByApiKeyId?: string | null;
  registrationMethod?: "operator" | "device";
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface DeviceAuthorizationRecord {
  id: string;
  suggestedSlug: string;
  status: "pending" | "approved" | "denied" | "expired" | "enrolled";
  pollIntervalSeconds: number;
  approvedOrganizationId: string | null;
  approvedByUserId: string | null;
  approvedSlug: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface StartDeviceAuthorizationInput {
  id: string;
  deviceVerifier: string;
  userCodeVerifier: string;
  fingerprintVerifier: string;
  suggestedSlug: string;
  lifetimeSeconds: number;
  pollIntervalSeconds: number;
  perFingerprintLimit: number;
  globalLimit: number;
}

export type DevicePollResult =
  | { status: "pending" | "slow_down" | "approved"; intervalSeconds: number }
  | { status: "denied" | "expired" | "enrolled"; intervalSeconds: number };

export interface DeviceDecisionAccess {
  sessionId: string;
  userId: string;
  membershipId: string;
  organizationId: string;
}

export type DeviceAuthorizationDecisionInput = {
  userCodeVerifier: string;
  access: DeviceDecisionAccess;
} & ({ decision: "approve"; slug: string } | { decision: "deny" });

export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  status: "active" | "archived";
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  activeConfigurationRevisionId: string | null;
}

export interface TenantRouteAccess {
  organization: { id: string; name: string; slug: string };
  membership: { id: string; role: "owner" | "admin" | "member" };
  project?: ProjectRecord;
}

export interface OrganizationConnectionUsage {
  github: GitHubConnectionRecord[];
  discord: DiscordConnectionRecord[];
  slack: SlackConnectionRecord[];
}

export interface GitHubRepositoryRecord {
  id: string;
  organizationId: string;
  connectionId: string;
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
}

export interface GitHubConfigurationTarget extends GitHubRepositoryRecord {
  projectId: string;
  installationId: number;
  automaticDeploymentEnabled: boolean;
}

export interface ConfigurationSyncAttemptRecord {
  id: string;
  projectId: string;
  githubConnectionId: string | null;
  githubRepositoryId: number | null;
  webhookDeliveryId: string | null;
  commitSha: string | null;
  outcome: string;
  evidence: unknown;
  createdAt: Date;
}

export interface ProjectConfigurationReadModel {
  authority: "manual" | "github";
  activeRevision: ProjectConfigurationRevisionRecord | null;
  lastSyncAttempt: ConfigurationSyncAttemptRecord | null;
  sourceState:
    | { kind: "manual"; formattingPreserved: boolean }
    | {
        kind: "github";
        githubConnectionId: string;
        githubRepositoryId: number;
        githubRepositoryFullName: string;
        githubDefaultBranch: string;
        automaticDeploymentEnabled: boolean;
      };
}

export interface ProjectConfigurationRevisionRecord {
  id: string;
  projectId: string;
  organizationId: string;
  version: number;
  sourceKind: "github" | "manual";
  sourceEvidence: unknown;
  rawYaml: string | null;
  normalizedConfiguration: unknown;
  validationErrors: unknown;
  contentHash: string;
  createdByUserId: string | null;
  receivedAt: Date | null;
  createdAt: Date;
  validatedAt: Date | null;
}

export type ConnectionProvider = "github" | "discord" | "slack";

export type ConnectionAttemptPhase =
  | "github_setup"
  | "github_user_authorization"
  | "discord_authorization"
  | "slack_authorization";

export interface ConnectionAccountAccess {
  sessionId: string;
  userId: string;
}

export interface ConnectionStartAuthority extends ConnectionAccountAccess {
  membershipId: string;
  organizationId: string;
  returnRoute: string;
}

export interface ConnectionAttemptRecord {
  id: string;
  provider: ConnectionProvider;
  phase: ConnectionAttemptPhase;
  organizationId: string;
  returnRoute: string;
  userId: string;
  sessionId: string;
  candidateExternalId: string | null;
  pkceVerifier: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface GitHubConnectionRecord {
  id: string;
  organizationId: string;
  slug: string;
  installationId: number;
  accountId: string;
  accountLogin: string;
  accountType: string;
  status: "active" | "suspended";
}

export interface DiscordConnectionRecord {
  id: string;
  organizationId: string;
  slug: string;
  guildId: string;
  guildName: string;
}

export interface SlackConnectionRecord {
  id: string;
  organizationId: string;
  slug: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  botAccessToken: string;
  scopes: string[];
}

export interface StartConnectionAttemptInput {
  provider: ConnectionProvider;
  stateVerifier: string;
  access: ConnectionStartAuthority;
  lifetimeMinutes: number;
}

export interface ReadConnectionAttemptInput {
  stateVerifier: string;
  phase: ConnectionAttemptPhase;
  access: ConnectionAccountAccess;
}

export interface AdvanceGitHubConnectionAttemptInput extends ReadConnectionAttemptInput {
  nextStateVerifier: string;
  installationId: number;
  pkceVerifier: string;
}

export interface BindGitHubConnectionInput extends ReadConnectionAttemptInput {
  installationId: number;
  accountId: string;
  accountLogin: string;
  accountType: string;
  status: "active" | "suspended";
}

export interface BindDiscordConnectionInput extends ReadConnectionAttemptInput {
  guildId: string;
  guildName: string;
}

export interface BindSlackConnectionInput extends ReadConnectionAttemptInput {
  teamId: string;
  teamName: string;
  botUserId: string;
  botAccessToken: string;
  scopes: string[];
}

export type DisconnectConnectionResult =
  | { provider: "github" }
  | { provider: "discord"; guildId: string | undefined }
  | {
      provider: "slack";
      teamId: string | undefined;
      botAccessToken: string | undefined;
    };

export type GitHubLifecycleIdentity = Omit<
  GitHubConnectionRecord,
  "id" | "organizationId" | "installationId" | "slug"
>;

export interface InsertProviderEventInput {
  organizationId: string;
  projectId: string | null;
  configurationRevisionId?: string | null;
  receiptId?: string;
  connectionId?: string | null;
  resourceId?: string | null;
  deliveryId: string;
  signatureHash?: string | null;
  source: string;
  repo?: string | null;
  payload: unknown;
  receivedAt: Date;
  matchedTriggerName?: string | null;
  droppedReason?: string | null;
}

export interface InsertProviderEventResult {
  inserted: boolean;
  receipt: ProviderEventReceiptRecord;
}

export interface DurableProviderEvent {
  providerEventReceiptId: string;
  organizationId: string;
  projectId: string;
  configurationRevisionId: string;
  deliveryId: string;
  source: string;
  payload: unknown;
  receivedAt: Date;
  connectionId: string | null;
  resourceId: string | null;
}

export type ProviderEventAcceptance =
  | { status: "accepted"; events: DurableProviderEvent[]; receiptId: string }
  | { status: "duplicate"; receiptId: string }
  | { status: "dropped"; receiptId: string; reason: string };

export interface ProviderEventEvidence {
  deliveryId: string;
  signatureHash?: string | null;
  source: string;
  repo?: string | null;
  payload: unknown;
  receivedAt: Date;
  dropReason?: string;
}

export interface AcceptGitHubEventInput extends ProviderEventEvidence {
  installationId: number;
  repositoryId?: number;
}

export interface AcceptDiscordEventInput extends ProviderEventEvidence {
  guildId: string;
}

export interface AcceptSlackEventInput extends ProviderEventEvidence {
  teamId: string;
}

export interface PersistManualEventInput extends InsertProviderEventInput {
  organizationId: string;
  projectId: string;
}

export type ManualEventPersistence =
  | { status: "accepted"; event: DurableProviderEvent }
  | { status: "duplicate"; providerEventReceiptId: string };

export interface GitHubLifecycleReceiptClaimInput {
  installationId: number;
  deliveryId: string;
  signatureHash: string;
  source: string;
  payload: unknown;
  receivedAt: Date;
}

export type GitHubLifecycleReceiptClaim =
  | { status: "claimed"; providerEventReceiptId: string; installationId: number }
  | { status: "duplicate"; providerEventReceiptId: string };

export type GitHubLifecycleResult =
  | { status: "absent"; removeBinding: boolean }
  | { status: "present"; identity: GitHubLifecycleIdentity };

export interface InsertMachineInput {
  orgId: string;
  source: MachineSource;
  status?: MachineStatus;
  triggerName?: string | null;
  triggerContext?: unknown;
  specs?: unknown;
}

export interface InsertAgentExecutionInput {
  id?: string;
  organizationId: string;
  projectId: string;
  machineId: string | null;
  daemonId?: string | null;
  startedAt?: Date;
  triggerContext: unknown;
  outputContext: unknown;
  configurationRevisionId: string;
  completionTokenHash?: string | null;
  deadlineAt?: Date | null;
  idleDeadlineAt?: Date | null;
  workflowStepRunId?: string | null;
  launchIntent?: LaunchMachineIntent | null;
  status?: "spawning" | "failed";
  result?: unknown;
}

interface TriggerRunEvidence {
  id: string;
  organizationId: string;
  projectId: string;
  configurationRevisionId: string;
  providerEventReceiptId: string;
  configuredTriggerName: string;
  rawPrompt: string;
  prompt: string;
  inputs: unknown;
  values: unknown;
  triggerContext: unknown;
  outputContext: unknown;
  createdAt: Date;
}

export interface AcceptedTriggerRunRecord extends TriggerRunEvidence {
  outcome: "accepted";
  status: "running" | "succeeded" | "failed" | "timed_out";
  deadlineAt: Date;
  deadlineKind: WorkflowDeadlineKind | null;
  failureReason: string | null;
  terminalNotificationPendingAt: Date | null;
  terminalNotificationDeliveredAt: Date | null;
  terminalNotificationLeaseExpiresAt: Date | null;
  completedAt: Date | null;
}

export interface RejectedTriggerRunRecord extends TriggerRunEvidence {
  outcome: "rejected";
  status: "rejected";
  rejection: InvocationRejection;
  completedAt: Date;
}

export type TriggerRunRecord = AcceptedTriggerRunRecord | RejectedTriggerRunRecord;

export interface ProjectActivityRunRecord {
  run: TriggerRunRecord;
  receipt: ProviderEventReceiptRecord;
  steps: readonly WorkflowStepRunRecord[];
}

export interface ProjectActivityRunListRecord {
  run: TriggerRunRecord;
  receipt: ProviderEventReceiptSummary;
}

export interface WorkflowStepRunRecord {
  id: string;
  triggerRunId: string;
  stepId: string;
  ordinal: number;
  status: "pending" | "running" | "succeeded" | "skipped" | "failed" | "timed_out";
  agentExecutionId: string | null;
  output: unknown;
  failureReason: string | null;
  deadlineKind: WorkflowDeadlineKind | null;
  deadlineAt: Date | null;
  idleDeadlineAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  dispatchIntent: LaunchMachineIntent | null;
}

export interface WorkflowWakeupRecord {
  triggerRunId: string;
  availableAt: Date;
  leaseExpiresAt: Date | null;
  leasedBeforeClaim: boolean;
}

export interface CreateAcceptedTriggerRunInput {
  id?: string;
  organizationId: string;
  projectId: string;
  configurationRevisionId: string;
  providerEventReceiptId: string;
  configuredTriggerName: string;
  rawPrompt: string;
  prompt: string;
  inputs: unknown;
  values?: unknown;
  triggerContext: unknown;
  outputContext: unknown;
  deadlineAt: Date;
  stepIds: readonly string[];
  createdAt?: Date;
}

export interface CreateRejectedTriggerRunInput {
  id?: string;
  organizationId: string;
  projectId: string;
  configurationRevisionId: string;
  providerEventReceiptId: string;
  configuredTriggerName: string;
  rawPrompt: string;
  prompt: string;
  inputs: unknown;
  values?: unknown;
  triggerContext: unknown;
  outputContext: unknown;
  rejection: InvocationRejection;
  createdAt?: Date;
}

/**
 * A meter reservation the durable engine attaches to execution creation. One unit is consumed
 * in the same transaction that creates the execution, so metering is exactly per-execution:
 * a genuinely new execution reserves, a replay or recovery of an existing one does not, and a
 * denial prevents the execution from being created at all. `limit` null means unlimited — the
 * unit is still counted (for usage display) but never denied.
 */
export interface MeterReservation {
  meter: string;
  periodStart: Date;
  limit: number | null;
}

/** Returned when a reservation would exceed a non-null limit; the execution is not created. */
export interface MeterReservationDenied {
  meter: string;
  limit: number;
  current: number;
}

export interface WorkflowStepExecutionInput {
  triggerRunId: string;
  stepId: string;
  ordinal: number;
  executionId: string;
  execution: Omit<InsertAgentExecutionInput, "deadlineAt" | "idleDeadlineAt" | "startedAt"> & {
    deadlineAt: Date;
    idleDeadlineAt: Date;
    startedAt: Date;
  };
  /** When set, one meter unit is reserved atomically with creating the execution. */
  reservation?: MeterReservation;
}

export interface WorkflowAgentCompletionInput {
  executionId: string;
  executionStatus: "succeeded" | "failed";
  stepStatus: "succeeded" | "failed" | "timed_out";
  result?: unknown;
  stepOutput?: unknown;
  failureReason?: string;
  deadlineKind?: WorkflowDeadlineKind;
  observedAt?: Date;
  completedByAgent?: boolean;
  deadlineCondition?: TransitionAgentExecutionFields["deadlineCondition"];
  hubAction?: HubAction | null;
}

export interface EnrollDaemonInput {
  daemonId: string;
  idempotencyKey: string;
  tokenVerifier: string;
  serverId: string;
  daemonPublicKey: string;
  credentialVerifier: string;
  scopes: string[];
  now: Date;
}

export interface CreateProjectInput {
  organizationId: string;
  name: string;
  slug: string;
  createdByUserId: string;
}

export type EntitlementChangeSource = "provisioning" | "plan_stamp" | "override";

export interface OrganizationEntitlementsRecord {
  organizationId: string;
  granted: unknown;
  overrides: unknown;
  planId: string | null;
  planVersion: string | null;
  stampedAt: Date;
  updatedAt: Date;
}

export interface StampOrganizationEntitlementsInput {
  organizationId: string;
  granted: unknown;
  planId: string | null;
  planVersion: string;
  source: EntitlementChangeSource;
  actor: string | null;
  reason: string | null;
}

export interface OverrideOrganizationEntitlementsInput {
  organizationId: string;
  overrides: unknown;
  actor: string | null;
  reason: string;
}

export interface EntitlementChangeRecord {
  id: string;
  organizationId: string;
  actor: string | null;
  /** Display name resolved from the actor's user record, when one exists. */
  actorName: string | null;
  source: EntitlementChangeSource;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: Date;
}

export interface OrganizationUsageRecord {
  organizationId: string;
  meter: string;
  periodStart: Date;
  used: number;
}

export interface ConsumeOrganizationUsageInput {
  organizationId: string;
  meter: string;
  periodStart: Date;
  amount: number;
  /** null means unlimited: the conditional upsert never denies. */
  limit: number | null;
}

export interface InsertProjectConfigurationRevisionInput {
  projectId: string;
  sourceKind: "github" | "manual";
  sourceEvidence: unknown;
  rawYaml?: string | null;
  normalizedConfiguration: unknown;
  validationErrors?: unknown;
  contentHash: string;
  createdByUserId?: string | null;
}

export interface ProjectTriggerRoute {
  provider: ConnectionProvider;
  connectionId: string;
  resourceId: string | null;
  triggerName: string;
}

export interface SwitchProjectConfigurationToManualInput {
  projectId: string;
  userId: string;
  rawYaml: string;
  normalizedConfiguration: unknown;
  contentHash: string;
  formattingPreserved: boolean;
  routes: readonly ProjectTriggerRoute[];
}

export interface SetProjectGitHubConfigurationSourceInput {
  projectId: string;
  githubConnectionId: string;
  githubRepositoryId: number;
  githubRepositoryFullName: string;
  githubDefaultBranch: string;
  automaticDeploymentEnabled: boolean;
  userId: string;
}

export interface RecordConfigurationSyncAttemptInput {
  projectId: string;
  githubConnectionId: string;
  githubRepositoryId: number;
  webhookDeliveryId: string | null;
  commitSha: string;
  outcome: "activated" | "invalid" | "fetch_failed" | "superseded";
  evidence: unknown;
}

export interface TransitionAgentExecutionFields {
  result?: unknown;
  completedByAgent?: boolean;
  deadlineCondition?: {
    kind: "hard" | "idle";
    deadlineAt: Date;
    observedAt: Date;
  };
  hubAction?: HubAction | null;
}

export interface TransitionAgentExecutionResult {
  execution: AgentExecutionRecord;
  transitioned: boolean;
  deadlineKind?: WorkflowDeadlineKind;
  terminalRun?: TriggerRunRecord;
}

export interface TransitionTriggerRunResult {
  run: TriggerRunRecord;
  transitioned: boolean;
}

export interface WorkflowDeadlineRecovery {
  triggerRunId: string;
  executionIds: readonly string[];
}

export interface TerminateMachineFields {
  reason: string;
}

export interface Database {
  createAcceptedTriggerRun(
    input: CreateAcceptedTriggerRunInput,
  ): Promise<{ run: AcceptedTriggerRunRecord; created: boolean }>;
  createRejectedTriggerRun(
    input: CreateRejectedTriggerRunInput,
  ): Promise<{ run: RejectedTriggerRunRecord; created: boolean }>;
  findTriggerRunById(id: string): Promise<TriggerRunRecord | undefined>;
  findTriggerRunsByProviderEventReceiptId(
    providerEventReceiptId: string,
  ): Promise<TriggerRunRecord[]>;
  listTriggerRunsForProject(projectId: string, limit: number): Promise<TriggerRunRecord[]>;
  listProjectActivityRuns(
    projectId: string,
    limit: number,
  ): Promise<ProjectActivityRunListRecord[]>;
  findProjectActivityRun(
    projectId: string,
    runId: string,
  ): Promise<ProjectActivityRunRecord | undefined>;
  updateTriggerRunValues(triggerRunId: string, values: unknown): Promise<TriggerRunRecord>;
  findWorkflowStepRunById(id: string): Promise<WorkflowStepRunRecord | undefined>;
  findWorkflowStepRunByTriggerRun(triggerRunId: string): Promise<WorkflowStepRunRecord | undefined>;
  listWorkflowStepRunsForTriggerRun(triggerRunId: string): Promise<WorkflowStepRunRecord[]>;
  findAgentExecutionByWorkflowStepRunId(
    stepRunId: string,
  ): Promise<AgentExecutionRecord | undefined>;
  claimWorkflowWakeup(now: Date, leaseMs: number): Promise<WorkflowWakeupRecord | undefined>;
  wakeWorkflowRun(triggerRunId: string, availableAt: Date): Promise<void>;
  deleteWorkflowWakeup(triggerRunId: string): Promise<void>;
  createWorkflowStepExecution(input: WorkflowStepExecutionInput): Promise<{
    stepRun: WorkflowStepRunRecord;
    execution: AgentExecutionRecord | undefined;
    created: boolean;
    /** Present only when a reservation was requested and denied; no execution was created. */
    reservationDenied?: MeterReservationDenied;
  }>;
  linkWorkflowStepRunExecution(
    stepRunId: string,
    executionId: string,
    dispatchIntent?: LaunchMachineIntent,
  ): Promise<WorkflowStepRunRecord>;
  completeWorkflowStep(
    executionId: string,
    status: "succeeded" | "failed" | "timed_out",
    result: unknown,
    failureReason?: string,
  ): Promise<{ stepRun: WorkflowStepRunRecord; run: TriggerRunRecord } | undefined>;
  completeWorkflowAgentExecution(
    input: WorkflowAgentCompletionInput,
  ): Promise<TransitionAgentExecutionResult>;
  markWorkflowStepSkipped(
    triggerRunId: string,
    stepId: string,
    reason: string,
  ): Promise<{ stepRun: WorkflowStepRunRecord; run: TriggerRunRecord } | undefined>;
  succeedTriggerRun(triggerRunId: string): Promise<TransitionTriggerRunResult | undefined>;
  failWorkflowRun(
    triggerRunId: string,
    status: "failed" | "timed_out",
    failureReason: string,
    stepId?: string,
  ): Promise<
    { stepRun: WorkflowStepRunRecord; run: TriggerRunRecord; transitioned: boolean } | undefined
  >;
  claimPendingWorkflowRunTerminalNotification(
    now: Date,
    leaseMs: number,
  ): Promise<TriggerRunRecord | undefined>;
  markWorkflowRunTerminalNotificationDelivered(
    triggerRunId: string,
    deliveredAt: Date,
  ): Promise<void>;
  recoverWorkflowDeadlines(now: Date): Promise<readonly WorkflowDeadlineRecovery[]>;
  recoverWorkflowWakeups(now: Date): Promise<void>;
  markProviderEventDropped(providerEventReceiptId: string, reason: string): Promise<void>;
  acceptGitHubEvent(input: AcceptGitHubEventInput): Promise<ProviderEventAcceptance>;
  acceptDiscordEvent(input: AcceptDiscordEventInput): Promise<ProviderEventAcceptance>;
  acceptSlackEvent(input: AcceptSlackEventInput): Promise<ProviderEventAcceptance>;
  persistManualEvent(input: PersistManualEventInput): Promise<ManualEventPersistence>;
  claimGitHubLifecycleReceipt(
    input: GitHubLifecycleReceiptClaimInput,
  ): Promise<GitHubLifecycleReceiptClaim>;
  applyGitHubLifecycle(
    claim: Extract<GitHubLifecycleReceiptClaim, { status: "claimed" }>,
    result: GitHubLifecycleResult,
  ): Promise<void>;
  releaseGitHubLifecycleReceipt(providerEventReceiptId: string): Promise<void>;
  findProviderEventReceiptByDeliveryId(
    deliveryId: string,
    organizationId?: string,
  ): Promise<ProviderEventReceiptRecord | undefined>;
  findProviderEventReceiptById(id: string): Promise<ProviderEventReceiptRecord | undefined>;
  insertAttachment(input: InsertAttachmentInput): Promise<AttachmentRecord>;
  findAttachmentBySource(
    providerEventReceiptId: string,
    provider: AttachmentProvider,
    sourceId: string,
  ): Promise<AttachmentRecord | undefined>;
  findAttachmentForExecution(
    executionId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | undefined>;
  insertMachine(input: InsertMachineInput): Promise<MachineRecord>;
  findMachineById(id: string): Promise<MachineRecord | undefined>;
  findMachineForOrganization(
    organizationId: string,
    id: string,
  ): Promise<MachineRecord | undefined>;
  transitionMachine(
    id: string,
    toStatus: MachineStatus,
    fields?: TerminateMachineFields,
  ): Promise<MachineRecord>;
  insertAgentExecution(input: InsertAgentExecutionInput): Promise<AgentExecutionRecord>;
  insertAgentExecutionIfAbsent(
    input: InsertAgentExecutionInput & { id: string },
  ): Promise<AgentExecutionRecord | undefined>;
  issueEnrollmentToken(input: EnrollmentTokenRecord): Promise<boolean>;
  startDeviceAuthorization(
    input: StartDeviceAuthorizationInput,
  ): Promise<DeviceAuthorizationRecord | undefined>;
  inspectDeviceAuthorization(
    userCodeVerifier: string,
  ): Promise<DeviceAuthorizationRecord | undefined>;
  decideDeviceAuthorization(
    input: DeviceAuthorizationDecisionInput,
  ): Promise<"approved" | "denied" | "unavailable" | "forbidden">;
  pollDeviceAuthorization(input: {
    deviceVerifier: string;
    enrollmentTokenVerifier: string;
  }): Promise<DevicePollResult>;
  enrollDaemon(input: EnrollDaemonInput): Promise<DaemonWriteResult>;
  findDaemonBySlugForOrganization(
    organizationId: string,
    slug: string,
  ): Promise<DaemonRecord | undefined>;
  findDaemonById(id: string): Promise<DaemonRecord | undefined>;
  findDaemonForOrganization(organizationId: string, id: string): Promise<DaemonRecord | undefined>;
  listDaemonsForOrganization(organizationId: string): Promise<DaemonRecord[]>;
  renameDaemonForOrganization(
    organizationId: string,
    id: string,
    slug: string,
  ): Promise<DaemonWriteResult>;
  touchDaemon(id: string): Promise<void>;
  setDaemonPresence(id: string, presence: "offline" | "connected"): Promise<void>;
  revokeDaemon(id: string): Promise<boolean>;
  attachAgentToExecution(
    executionId: string,
    daemonId: string,
    agentId: string,
  ): Promise<AgentExecutionRecord>;
  setAgentExecutionIdleDeadline(
    executionId: string,
    idleDeadlineAt: Date | null,
    observedAt: Date,
    processedAt: Date,
  ): Promise<AgentExecutionRecord>;
  prepareAgentExecutionForDispatch(
    executionId: string,
    daemonId: string,
    machineId: string,
    completionTokenHash: string,
  ): Promise<AgentExecutionRecord>;
  findAgentExecutionById(id: string): Promise<AgentExecutionRecord | undefined>;
  findAgentExecutionForOrganization(
    organizationId: string,
    id: string,
  ): Promise<AgentExecutionRecord | undefined>;
  findAgentExecutionForProject(
    projectId: string,
    id: string,
  ): Promise<AgentExecutionRecord | undefined>;
  beginAgentExecutionOutput(
    executionId: string,
    outputType: string,
    maxOutputs: number,
    startedAt: Date,
  ): Promise<AgentExecutionOutputAttempt | undefined>;
  completeAgentExecutionOutput(
    executionId: string,
    attemptId: string,
    completedAt: Date,
  ): Promise<AgentExecutionRecord | undefined>;
  failAgentExecutionOutput(
    executionId: string,
    attemptId: string,
    failedAt: Date,
  ): Promise<boolean>;
  transitionAgentExecution(
    id: string,
    toStatus: AgentExecutionStatus,
    fields?: TransitionAgentExecutionFields,
  ): Promise<TransitionAgentExecutionResult>;
  findRunningAgentExecutionsForMachine(machineId: string): Promise<AgentExecutionRecord[]>;
  findPendingAgentExecutions(): Promise<AgentExecutionRecord[]>;
  findPendingHubActions(daemonId?: string): Promise<AgentExecutionRecord[]>;
  markAgentExecutionHubActionReady(
    executionId: string,
    observedAt?: Date,
  ): Promise<AgentExecutionRecord | undefined>;
  recordAgentExecutionHubAcknowledgement(
    executionId: string,
    acknowledgement: AgentExecutionHubAcknowledgementInput,
  ): Promise<AgentExecutionRecord | undefined>;
  completeHubAction(executionId: string, action: HubAction): Promise<boolean>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  getOrganizationEntitlements(
    organizationId: string,
  ): Promise<OrganizationEntitlementsRecord | undefined>;
  stampOrganizationEntitlements(
    input: StampOrganizationEntitlementsInput,
  ): Promise<OrganizationEntitlementsRecord>;
  overrideOrganizationEntitlements(
    input: OverrideOrganizationEntitlementsInput,
  ): Promise<OrganizationEntitlementsRecord>;
  listEntitlementChanges(organizationId: string, limit: number): Promise<EntitlementChangeRecord[]>;
  /**
   * Single atomic conditional upsert: increments `used` by `amount` and returns the new
   * row, unless doing so would exceed `limit` (when non-null), in which case it returns
   * `undefined` and leaves usage unchanged. Never read-then-write — see the plan.
   */
  consumeOrganizationUsage(
    input: ConsumeOrganizationUsageInput,
  ): Promise<OrganizationUsageRecord | undefined>;
  getOrganizationUsage(
    organizationId: string,
    meter: string,
    periodStart: Date,
  ): Promise<OrganizationUsageRecord | undefined>;
  listProjectsForOrganization(organizationId: string): Promise<ProjectRecord[]>;
  findProjectForOrganization(
    organizationId: string,
    projectId: string,
  ): Promise<ProjectRecord | undefined>;
  findProjectById(projectId: string): Promise<ProjectRecord | undefined>;
  findProjectBySlugForOrganization(
    organizationId: string,
    slug: string,
  ): Promise<ProjectRecord | undefined>;
  resolveTenantRouteAccess(
    userId: string,
    organizationSlug: string,
    projectSlug?: string,
  ): Promise<TenantRouteAccess | undefined>;
  archiveProject(organizationId: string, projectId: string, userId: string): Promise<ProjectRecord>;
  updateProjectSlug(
    organizationId: string,
    projectId: string,
    slug: string,
    userId: string,
  ): Promise<ProjectRecord>;
  insertProjectConfigurationRevision(
    input: InsertProjectConfigurationRevisionInput,
  ): Promise<ProjectConfigurationRevisionRecord>;
  activateProjectConfigurationRevision(
    projectId: string,
    revisionId: string,
    routes?: readonly ProjectTriggerRoute[],
  ): Promise<ProjectConfigurationRevisionRecord>;
  findProjectConfigurationRollbackTarget(
    projectId: string,
  ): Promise<ProjectConfigurationRevisionRecord | undefined>;
  rollbackProjectConfiguration(
    projectId: string,
    targetRevisionId: string,
    routes: readonly ProjectTriggerRoute[],
  ): Promise<ProjectConfigurationRevisionRecord>;
  findActiveProjectConfiguration(
    projectId: string,
  ): Promise<ProjectConfigurationRevisionRecord | undefined>;
  findProjectConfigurationRevision(
    projectId: string,
    revisionId: string,
  ): Promise<ProjectConfigurationRevisionRecord | undefined>;
  switchProjectConfigurationToManual(
    input: SwitchProjectConfigurationToManualInput,
  ): Promise<ProjectConfigurationRevisionRecord>;
  setProjectGitHubConfigurationSource(
    input: SetProjectGitHubConfigurationSourceInput,
  ): Promise<void>;
  recordConfigurationSyncAttempt(
    input: RecordConfigurationSyncAttemptInput,
  ): Promise<ConfigurationSyncAttemptRecord>;
  projectConfigurationReadModel(projectId: string): Promise<ProjectConfigurationReadModel>;
  organizationConnectionUsage(organizationId: string): Promise<OrganizationConnectionUsage>;
  listGitHubRepositories(organizationId: string): Promise<GitHubRepositoryRecord[]>;
  findGitHubRepositoryForOrganization(
    organizationId: string,
    fullName: string,
  ): Promise<GitHubRepositoryRecord | undefined>;
  upsertGitHubRepositories(
    organizationId: string,
    connectionId: string,
    repositories: Array<
      Pick<GitHubRepositoryRecord, "repositoryId" | "fullName" | "defaultBranch">
    >,
  ): Promise<void>;
  findGitHubConfigurationTarget(
    projectId: string,
    repositoryId?: number,
  ): Promise<GitHubConfigurationTarget | undefined>;
  listGitHubConfigurationTargets(
    organizationId: string,
    connectionId: string,
    repositoryId: number,
  ): Promise<GitHubConfigurationTarget[]>;
  listUnroutedProviderEventsForOrganization(
    organizationId: string,
  ): Promise<ProviderEventReceiptSummary[]>;
  isOrganizationMember(userId: string, organizationId: string): Promise<boolean>;
  startConnectionAttempt(input: StartConnectionAttemptInput): Promise<void>;
  readConnectionAttempt(input: ReadConnectionAttemptInput): Promise<ConnectionAttemptRecord>;
  consumeConnectionAttempt(input: ReadConnectionAttemptInput): Promise<void>;
  advanceGitHubConnectionAttempt(input: AdvanceGitHubConnectionAttemptInput): Promise<void>;
  bindGitHubConnection(input: BindGitHubConnectionInput): Promise<void>;
  bindDiscordConnection(input: BindDiscordConnectionInput): Promise<void>;
  bindSlackConnection(input: BindSlackConnectionInput): Promise<void>;
  disconnectConnection(
    provider: ConnectionProvider,
    connectionId: string,
    access: ConnectionStartAuthority,
  ): Promise<DisconnectConnectionResult>;
  findGitHubConnection(installationId: number): Promise<GitHubConnectionRecord | undefined>;
  findDiscordConnection(guildId: string): Promise<DiscordConnectionRecord | undefined>;
  findSlackConnection(teamId: string): Promise<SlackConnectionRecord | undefined>;
  findSlackConnectionForOrganization(
    organizationId: string,
    teamId: string,
  ): Promise<SlackConnectionRecord | undefined>;
  findDiscordConnectionForOrganization(
    organizationId: string,
    guildId: string,
  ): Promise<DiscordConnectionRecord | undefined>;
  removeDiscordConnection(guildId: string): Promise<void>;
  close(): Promise<void>;
}
