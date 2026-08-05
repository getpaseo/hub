import type { AgentExecutionStatus, MachineSource, MachineStatus } from "./schema.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { InvocationRejection } from "../triggers/invocation.js";

export interface TriggerRecord {
  id: string;
  organizationId: string;
  projectId: string | null;
  configurationRevisionId: string | null;
  receiptId: string;
  connectionId: string | null;
  resourceId: string | null;
  deliveryId: string;
  signatureHash: string | null;
  source: string;
  repo: string | null;
  payload: unknown;
  receivedAt: Date;
  matchedTriggerName: string | null;
  configuredTriggerNames: readonly string[];
  droppedReason: string | null;
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
  launchIntent: LaunchMachineIntent | null;
  daemonId: string | null;
  daemonAgentId: string | null;
  triggerId: string | null;
  triggerConnectionId: string | null;
  triggerResourceId: string | null;
  workflowStepRunId: string | null;
  hubAction: HubAction | null;
  hubActionCompletedAt: Date | null;
}

export type HubAction = "interrupt" | "archive";

export interface DaemonRecord {
  id: string;
  slug: string;
  machineId: string;
  serverId: string;
  daemonPublicKey: string;
  credentialVerifier: string;
  scopes: string[];
  displayName: string;
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

export interface EnrollmentTokenRecord {
  id: string;
  verifier: string;
  organizationId: string;
  authorizationId?: string | null;
  displayName?: string | null;
  approvedByUserId?: string | null;
  issuedByApiKeyId?: string | null;
  registrationMethod?: "operator" | "device";
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface DeviceAuthorizationRecord {
  id: string;
  suggestedDisplayName: string;
  status: "pending" | "approved" | "denied" | "expired" | "enrolled";
  pollIntervalSeconds: number;
  approvedOrganizationId: string | null;
  approvedByUserId: string | null;
  approvedDisplayName: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface StartDeviceAuthorizationInput {
  id: string;
  deviceVerifier: string;
  userCodeVerifier: string;
  fingerprintVerifier: string;
  suggestedDisplayName: string;
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
} & ({ decision: "approve"; displayName: string } | { decision: "deny" });

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

export interface InsertTriggerInput {
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

export interface InsertTriggerResult {
  inserted: boolean;
  trigger: TriggerRecord;
}

export interface DurableTrigger {
  triggerId: string;
  organizationId: string;
  projectId: string;
  deliveryId: string;
  source: string;
  payload: unknown;
  receivedAt: Date;
  connectionId: string | null;
  resourceId: string | null;
}

export type ProviderTriggerAcceptance =
  | { status: "accepted"; triggers: DurableTrigger[]; receiptId: string }
  | { status: "duplicate"; triggerIds: string[]; receiptId: string }
  | { status: "dropped"; receiptId: string; reason: string };

export interface ProviderTriggerEvidence {
  deliveryId: string;
  signatureHash?: string | null;
  source: string;
  repo?: string | null;
  payload: unknown;
  receivedAt: Date;
  dropReason?: string;
}

export interface AcceptGitHubTriggerInput extends ProviderTriggerEvidence {
  installationId: number;
  repositoryId?: number;
}

export interface AcceptDiscordTriggerInput extends ProviderTriggerEvidence {
  guildId: string;
}

export interface AcceptSlackTriggerInput extends ProviderTriggerEvidence {
  teamId: string;
}

export interface PersistManualTriggerInput extends InsertTriggerInput {
  organizationId: string;
  projectId: string;
}

export type ManualTriggerPersistence =
  | { status: "accepted"; trigger: DurableTrigger }
  | { status: "duplicate"; triggerId: string };

export interface GitHubLifecycleClaimInput {
  installationId: number;
  deliveryId: string;
  signatureHash: string;
  source: string;
  payload: unknown;
  receivedAt: Date;
}

export type GitHubLifecycleClaim =
  | { status: "claimed"; triggerId: string; installationId: number }
  | { status: "duplicate"; triggerId: string };

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
  triggerContext: unknown;
  outputContext: unknown;
  configurationRevisionId: string;
  completionTokenHash?: string | null;
  deadlineAt?: Date | null;
  idleDeadlineAt?: Date | null;
  triggerId?: string | null;
  triggerConnectionId?: string | null;
  triggerResourceId?: string | null;
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
  triggerId: string;
  configuredTriggerName: string;
  rawPrompt: string;
  prompt: string;
  inputs: unknown;
  triggerContext: unknown;
  outputContext: unknown;
  createdAt: Date;
}

export interface AcceptedTriggerRunRecord extends TriggerRunEvidence {
  outcome: "accepted";
  status: "running" | "succeeded" | "failed" | "timed_out";
  deadlineAt: Date;
  failureReason: string | null;
  completedAt: Date | null;
}

export interface RejectedTriggerRunRecord extends TriggerRunEvidence {
  outcome: "rejected";
  status: "rejected";
  rejection: InvocationRejection;
  completedAt: Date;
}

export type TriggerRunRecord = AcceptedTriggerRunRecord | RejectedTriggerRunRecord;

export interface WorkflowStepRunRecord {
  id: string;
  triggerRunId: string;
  stepId: string;
  ordinal: number;
  status: "pending" | "running" | "succeeded" | "skipped" | "failed" | "timed_out";
  agentExecutionId: string | null;
  output: unknown;
  failureReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  dispatchIntent: LaunchMachineIntent | null;
}

export interface WorkflowWakeupRecord {
  triggerRunId: string;
  availableAt: Date;
  leaseExpiresAt: Date | null;
}

export interface CreateAcceptedTriggerRunInput {
  id?: string;
  organizationId: string;
  projectId: string;
  configurationRevisionId: string;
  triggerId: string;
  configuredTriggerName: string;
  rawPrompt: string;
  prompt: string;
  inputs: unknown;
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
  triggerId: string;
  configuredTriggerName: string;
  rawPrompt: string;
  prompt: string;
  inputs: unknown;
  triggerContext: unknown;
  outputContext: unknown;
  rejection: InvocationRejection;
  createdAt?: Date;
}

export interface WorkflowStepExecutionInput {
  triggerRunId: string;
  stepId: string;
  ordinal: number;
  executionId: string;
  execution: InsertAgentExecutionInput;
}

export interface WorkflowAgentCompletionInput {
  executionId: string;
  executionStatus: "succeeded" | "failed";
  stepStatus: "succeeded" | "failed" | "timed_out";
  result?: unknown;
  stepOutput?: unknown;
  failureReason?: string;
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
  findTriggerRunsByTriggerId(triggerId: string): Promise<TriggerRunRecord[]>;
  listTriggerRunsForProject(projectId: string, limit: number): Promise<TriggerRunRecord[]>;
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
  succeedTriggerRun(triggerRunId: string): Promise<TriggerRunRecord | undefined>;
  failWorkflowRun(
    triggerRunId: string,
    status: "failed" | "timed_out",
    failureReason: string,
    stepId?: string,
  ): Promise<{ stepRun: WorkflowStepRunRecord; run: TriggerRunRecord } | undefined>;
  recoverWorkflowWakeups(now: Date): Promise<void>;
  insertTrigger(input: InsertTriggerInput): Promise<InsertTriggerResult>;
  markTriggerDropped(id: string, reason: string): Promise<TriggerRecord>;
  acceptGitHubTrigger(input: AcceptGitHubTriggerInput): Promise<ProviderTriggerAcceptance>;
  acceptDiscordTrigger(input: AcceptDiscordTriggerInput): Promise<ProviderTriggerAcceptance>;
  acceptSlackTrigger(input: AcceptSlackTriggerInput): Promise<ProviderTriggerAcceptance>;
  persistManualTrigger(input: PersistManualTriggerInput): Promise<ManualTriggerPersistence>;
  claimGitHubLifecycle(input: GitHubLifecycleClaimInput): Promise<GitHubLifecycleClaim>;
  applyGitHubLifecycle(
    claim: Extract<GitHubLifecycleClaim, { status: "claimed" }>,
    result: GitHubLifecycleResult,
  ): Promise<void>;
  releaseGitHubLifecycleClaim(triggerId: string): Promise<void>;
  findTriggerByDeliveryId(
    deliveryId: string,
    organizationId?: string,
  ): Promise<TriggerRecord | undefined>;
  findTriggerById(id: string): Promise<TriggerRecord | undefined>;
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
  enrollDaemon(input: EnrollDaemonInput): Promise<DaemonRecord | undefined>;
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
    displayName: string,
  ): Promise<DaemonRecord | undefined>;
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
  findAgentExecutionByTriggerId(triggerId: string): Promise<AgentExecutionRecord | undefined>;
  findAgentExecutionsByTriggerId(triggerId: string): Promise<AgentExecutionRecord[]>;
  listAgentExecutionsForProject(projectId: string, limit: number): Promise<AgentExecutionRecord[]>;
  listTriggersForProject(projectId: string, limit: number): Promise<TriggerRecord[]>;
  claimAgentExecutionReply(
    executionId: string,
    maxReplies: number,
    claimedAt: Date,
  ): Promise<boolean>;
  transitionAgentExecution(
    id: string,
    toStatus: AgentExecutionStatus,
    fields?: TransitionAgentExecutionFields,
  ): Promise<TransitionAgentExecutionResult>;
  findRunningAgentExecutionsForMachine(machineId: string): Promise<AgentExecutionRecord[]>;
  findPendingAgentExecutions(): Promise<AgentExecutionRecord[]>;
  findPendingHubActions(daemonId?: string): Promise<AgentExecutionRecord[]>;
  completeHubAction(executionId: string, action: HubAction): Promise<boolean>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
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
  listUnroutedTriggersForOrganization(organizationId: string): Promise<TriggerRecord[]>;
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
