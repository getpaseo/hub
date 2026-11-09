import { capabilitiesFor } from "../auth/organization-policy.js";
import type { AuthServer } from "../auth/server.js";
import { revisionBundleFiles } from "../configuration/store.js";
import type {
  AgentExecutionRecord,
  Database,
  ProjectActivityRunListRecord,
  ProjectActivityRunRecord,
  ProviderEventReceiptSummary,
} from "../db/types.js";
import {
  decodeEntitlementDenialFailureReason,
  entitlementDenialSummary,
} from "../entitlements/denial.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { organizationConnections } from "../providers/resources.js";
import { providerEventDropReasonSummary } from "../triggers/drop-reason.js";
import { formatInvocationRejection } from "../triggers/invocation.js";
import { resolveRouteTenant } from "./access.js";
import { ProjectCommandError } from "./command-error.js";

/** A jsonb column value, cast at the DB boundary so it survives the server-fn serializer. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ProjectRouteScope {
  organizationSlug: string;
  projectSlug?: string | undefined;
}

export class ProjectDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly providers: ProviderRegistry,
  ) {}

  async tenantContext(request: Request, scope: ProjectRouteScope) {
    const { account, tenant } = await this.resolve(request, scope);
    return {
      account: account.account,
      organization: tenant.organization,
      membership: tenant.membership,
      capabilities: capabilitiesFor(tenant.membership.role),
      project: tenant.project === undefined ? null : projectView(tenant.project),
      projects: (await this.database.listProjectsForOrganization(tenant.organization.id)).map(
        projectView,
      ),
    };
  }

  async organizationSnapshot(request: Request, scope: ProjectRouteScope) {
    const { account, tenant } = await this.resolve(request, organizationScope(scope));
    const [projects, connections, unroutedEvents, daemons] = await Promise.all([
      this.database.listProjectsForOrganization(tenant.organization.id),
      organizationConnections(this.database, this.providers, tenant.organization.id),
      this.database.listUnroutedProviderEventsForOrganization(tenant.organization.id),
      this.database.listDaemonsForOrganization(tenant.organization.id),
    ]);
    return {
      account: account.account,
      organization: tenant.organization,
      membership: tenant.membership,
      capabilities: capabilitiesFor(tenant.membership.role),
      projects: projects.map(projectView),
      connections: connectionUsageView(connections, this.providers),
      unroutedEvents: unroutedEvents.map(unroutedEventView),
      daemons: daemons.map(daemonView),
    };
  }

  async projectSnapshot(request: Request, scope: ProjectRouteScope) {
    const { account, tenant } = await this.resolveProject(request, scope);
    const project = tenant.project;
    const [projects, configuration, organizationDaemons, connections, repositories, activity] =
      await Promise.all([
        this.database.listProjectsForOrganization(tenant.organization.id),
        this.database.projectConfigurationReadModel(project.id),
        this.database.listDaemonsForOrganization(tenant.organization.id),
        organizationConnections(this.database, this.providers, tenant.organization.id),
        this.database.listGitHubRepositories(tenant.organization.id),
        this.database.listProjectActivityRuns(project.id, 50),
      ]);
    return {
      account: account.account,
      organization: tenant.organization,
      membership: tenant.membership,
      capabilities: capabilitiesFor(tenant.membership.role),
      project: projectView(project),
      projects: projects.map(projectView),
      configuration: configurationView(configuration),
      organizationDaemons: organizationDaemons.map(daemonView),
      connections: connectionUsageView(connections, this.providers),
      repositories: repositories.map((repository) => ({
        id: repository.id,
        connectionId: repository.connectionId,
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
      })),
      activity: activity.map(activityRunListView),
    };
  }

  async activityRunSnapshot(request: Request, scope: ProjectRouteScope & { runId: string }) {
    const { account, tenant } = await this.resolveProject(request, scope);
    const activity = await this.database.findProjectActivityRun(tenant.project.id, scope.runId);
    if (activity === undefined) throw new ProjectCommandError("run_unavailable");
    return {
      account: account.account,
      organization: tenant.organization,
      membership: tenant.membership,
      capabilities: capabilitiesFor(tenant.membership.role),
      project: projectView(tenant.project),
      activity: activityRunView(
        activity,
        await Promise.all(
          activity.steps.map(async (step) =>
            step.agentExecutionId === null
              ? undefined
              : this.database.findAgentExecutionById(step.agentExecutionId),
          ),
        ),
      ),
    };
  }

  async createProject(
    request: Request,
    scope: ProjectRouteScope,
    input: { name: string; slug: string },
  ) {
    const { account, tenant } = await this.resolveManager(request, organizationScope(scope));
    return this.database.createProject({
      organizationId: tenant.organization.id,
      name: input.name,
      slug: input.slug,
      createdByUserId: account.account.id,
    });
  }

  async archiveProject(request: Request, scope: ProjectRouteScope) {
    const { account, tenant } = await this.resolveProjectManager(request, scope);
    return this.database.archiveProject(
      tenant.organization.id,
      tenant.project.id,
      account.account.id,
    );
  }

  async updateProjectSlug(request: Request, scope: ProjectRouteScope, slug: string) {
    const { account, tenant } = await this.resolveProjectManager(request, scope);
    return this.database.updateProjectSlug(
      tenant.organization.id,
      tenant.project.id,
      slug,
      account.account.id,
    );
  }

  private resolve(request: Request, scope: ProjectRouteScope) {
    return resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug: scope.organizationSlug,
      ...(scope.projectSlug === undefined ? {} : { projectSlug: scope.projectSlug }),
    });
  }

  private async resolveProject(request: Request, scope: ProjectRouteScope) {
    if (scope.projectSlug === undefined) throw new ProjectCommandError("project_unavailable");
    const resolved = await this.resolve(request, scope);
    const project = resolved.tenant.project;
    if (project === undefined) throw new ProjectCommandError("project_unavailable");
    return {
      account: resolved.account,
      tenant: {
        organization: resolved.tenant.organization,
        membership: resolved.tenant.membership,
        project,
      },
    };
  }

  private async resolveManager(request: Request, scope: ProjectRouteScope) {
    const resolved = await this.resolve(request, scope);
    if (!capabilitiesFor(resolved.tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    return resolved;
  }

  private async resolveProjectManager(request: Request, scope: ProjectRouteScope) {
    const resolved = await this.resolveProject(request, scope);
    if (!capabilitiesFor(resolved.tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    return resolved;
  }
}

function organizationScope(scope: ProjectRouteScope): ProjectRouteScope {
  return { organizationSlug: scope.organizationSlug };
}

function projectView(project: Awaited<ReturnType<Database["createProject"]>>) {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    status: project.status,
    createdAt: project.createdAt.toISOString(),
    archivedAt: project.archivedAt?.toISOString() ?? null,
  };
}

function daemonView(daemon: Awaited<ReturnType<Database["findDaemonById"]>> & {}) {
  if (daemon === undefined) throw new Error("daemon unavailable");
  return {
    id: daemon.id,
    slug: daemon.slug,
    status: daemon.status,
    presence: daemon.presence,
    lastSeenAt: daemon.lastSeenAt.toISOString(),
  };
}

function connectionUsageView(
  connections: Awaited<ReturnType<typeof organizationConnections>>,
  providers: ProviderRegistry,
) {
  return Object.fromEntries(
    [...connections]
      .sort(
        (a, b) =>
          (providers.require(a.provider).manifest.connectionOrder ?? 0) -
          (providers.require(b.provider).manifest.connectionOrder ?? 0),
      )
      .map(({ provider, connections: items }) => [
        provider,
        items.map((connection) => connection.view),
      ]),
  );
}

function configurationView(
  configuration: Awaited<ReturnType<Database["projectConfigurationReadModel"]>>,
) {
  const active = configuration.activeRevision;
  const attempt = configuration.lastSyncAttempt;
  return {
    authority: configuration.authority,
    sourceState: configuration.sourceState,
    activeRevision:
      active === null
        ? null
        : {
            id: active.id,
            version: active.version,
            sourceKind: active.sourceKind,
            files: revisionBundleFiles(active),
            validation: active.validationErrors === null ? "valid" : "invalid",
            createdAt: active.createdAt.toISOString(),
          },
    lastSyncAttempt:
      attempt === null
        ? null
        : {
            id: attempt.id,
            commitSha: attempt.commitSha,
            outcome: attempt.outcome,
            createdAt: attempt.createdAt.toISOString(),
          },
  };
}

function activityRunView(
  activity: ProjectActivityRunRecord,
  executions: (AgentExecutionRecord | undefined)[],
) {
  const { run, receipt, steps } = activity;
  const base = {
    id: run.id,
    providerEventReceiptId: run.providerEventReceiptId,
    provider: receipt.provider,
    deliveryId: receipt.deliveryId,
    source: receipt.source,
    repo: receipt.repo,
    receivedAt: receipt.receivedAt.toISOString(),
    rawPayload: jsonValue(receipt.payload),
    configuredTriggerName: run.configuredTriggerName,
    prompt: run.prompt,
    inputs: jsonValue(run.inputs),
    values: jsonValue(run.values),
    triggerContext: jsonValue(run.triggerContext),
    outputContext: jsonValue(run.outputContext),
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    steps: steps.map((step, index) => ({
      agentId: executions[index]?.daemonAgentId ?? null,
      agentSessionId: executions[index]?.agentSessionId ?? null,
      agentSessionAction: executions[index]?.agentSessionAction ?? null,
      id: step.id,
      stepId: step.stepId,
      ordinal: step.ordinal,
      status: step.status,
      deadlineAt: step.deadlineAt?.toISOString() ?? null,
      idleDeadlineAt: step.idleDeadlineAt?.toISOString() ?? null,
      deadlineKind: step.deadlineKind,
      startedAt: step.startedAt?.toISOString() ?? null,
      output: step.output === null ? null : jsonValue(step.output),
      failureReason: displayFailureReason(step.failureReason),
      completedAt: step.completedAt?.toISOString() ?? null,
    })),
  };
  if (run.outcome === "rejected") {
    return {
      ...base,
      outcome: run.outcome,
      status: run.status,
      deadlineAt: null,
      deadlineKind: null,
      failureReason: formatInvocationRejection(run.rejection),
      rejectionReason: formatInvocationRejection(run.rejection),
    };
  }
  return {
    ...base,
    outcome: run.outcome,
    status: run.status,
    deadlineAt: run.deadlineAt.toISOString(),
    deadlineKind: run.deadlineKind,
    failureReason: displayFailureReason(run.failureReason),
    rejectionReason: null,
  };
}

function activityRunListView(activity: ProjectActivityRunListRecord) {
  const { run, receipt } = activity;
  const base = {
    id: run.id,
    providerEventReceiptId: run.providerEventReceiptId,
    provider: receipt.provider,
    deliveryId: receipt.deliveryId,
    source: receipt.source,
    repo: receipt.repo,
    receivedAt: receipt.receivedAt.toISOString(),
    configuredTriggerName: run.configuredTriggerName,
    prompt: run.prompt,
    inputs: jsonValue(run.inputs),
    values: jsonValue(run.values),
    outputContext: jsonValue(run.outputContext),
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
  if (run.outcome === "rejected") {
    return {
      ...base,
      outcome: run.outcome,
      status: run.status,
      deadlineAt: null,
      deadlineKind: null,
      failureReason: formatInvocationRejection(run.rejection),
      rejectionReason: formatInvocationRejection(run.rejection),
    };
  }
  return {
    ...base,
    outcome: run.outcome,
    status: run.status,
    deadlineAt: run.deadlineAt.toISOString(),
    deadlineKind: run.deadlineKind,
    failureReason: displayFailureReason(run.failureReason),
    rejectionReason: null,
  };
}

/**
 * A run/step `failure_reason` for display. An entitlement denial is stored as a machine-parseable
 * payload (see engine.ts), so it is decoded into a typed denial and summarized here rather than
 * shown as raw JSON; every other reason (timeouts, crashes) passes through unchanged.
 */
function displayFailureReason(reason: string | null): string | null {
  const denial = decodeEntitlementDenialFailureReason(reason);
  return denial === undefined ? reason : entitlementDenialSummary(denial);
}

function unroutedEventView(receipt: ProviderEventReceiptSummary) {
  return {
    id: receipt.id,
    providerEventReceiptId: receipt.id,
    provider: receipt.provider,
    deliveryId: receipt.deliveryId,
    source: receipt.source,
    repo: receipt.repo,
    receivedAt: receipt.receivedAt.toISOString(),
    configuredTriggerName: null,
    prompt: null,
    inputs: {},
    values: {},
    triggerContext: {},
    outputContext: {},
    createdAt: receipt.receivedAt.toISOString(),
    completedAt: null,
    outcome: "dropped" as const,
    status: "dropped" as const,
    deadlineAt: null,
    deadlineKind: null,
    failureReason:
      receipt.droppedReason === null ? null : providerEventDropReasonSummary(receipt.droppedReason),
    rejectionReason: null,
    steps: [],
  };
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  }
  return null;
}
