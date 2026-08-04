import { load } from "js-yaml";
import type { AuthServer } from "../auth/server.js";
import { capabilitiesFor } from "../auth/organization-policy.js";
import { configurationHash, ProjectConfigurationStore } from "../configuration/store.js";
import {
  synchronizeGitHubDefaultBranch,
  type GitHubConfigurationProvider,
} from "../configuration/github-sync.js";
import type { Database } from "../db/types.js";
import { resolveRouteTenant } from "./access.js";

export interface ProjectRouteScope {
  organizationSlug: string;
  projectSlug?: string | undefined;
}

export class ProjectDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly github: GitHubConfigurationProvider | undefined,
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
      this.database.organizationConnectionUsage(tenant.organization.id),
      this.database.listUnroutedTriggersForOrganization(tenant.organization.id),
      this.database.listDaemonsForOrganization(tenant.organization.id),
    ]);
    return {
      account: account.account,
      organization: tenant.organization,
      membership: tenant.membership,
      capabilities: capabilitiesFor(tenant.membership.role),
      projects: projects.map(projectView),
      connections: connectionUsageView(connections),
      unroutedEvents: unroutedEvents.map(triggerView),
      daemons: daemons.map(daemonView),
    };
  }

  async projectSnapshot(request: Request, scope: ProjectRouteScope) {
    const { account, tenant } = await this.resolveProject(request, scope);
    const project = tenant.project;
    const [
      projects,
      configuration,
      organizationDaemons,
      connections,
      repositories,
      activity,
      executions,
    ] = await Promise.all([
      this.database.listProjectsForOrganization(tenant.organization.id),
      this.database.projectConfigurationReadModel(project.id),
      this.database.listDaemonsForOrganization(tenant.organization.id),
      this.database.organizationConnectionUsage(tenant.organization.id),
      this.database.listGitHubRepositories(tenant.organization.id),
      this.database.listTriggersForProject(project.id, 50),
      this.database.listAgentExecutionsForProject(project.id, 50),
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
      connections: connectionUsageView(connections),
      repositories: repositories.map((repository) => ({
        id: repository.id,
        connectionId: repository.connectionId,
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
      })),
      activity: activity.map(triggerView),
      executions: executions.map(executionView),
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

  async availableGitHubRepositories(request: Request, scope: ProjectRouteScope) {
    const { tenant } = await this.resolveProject(request, scope);
    const connections = (await this.database.organizationConnectionUsage(tenant.organization.id))
      .github;
    if (this.github === undefined) {
      throw new ProjectCommandError("github_repositories_unavailable");
    }
    for (const connection of connections) {
      const available = await this.github.listInstallationRepositories({
        installationId: connection.installationId,
      });
      await this.database.upsertGitHubRepositories(
        tenant.organization.id,
        connection.id,
        available,
      );
    }
    return this.database.listGitHubRepositories(tenant.organization.id);
  }

  async useGitHubConfiguration(
    request: Request,
    scope: ProjectRouteScope,
    input: { connectionId: string; repositoryId: number },
  ) {
    const { account, tenant } = await this.resolveProjectManager(request, scope);
    const repository = (await this.availableGitHubRepositories(request, scope)).find(
      (candidate) =>
        candidate.connectionId === input.connectionId &&
        candidate.repositoryId === input.repositoryId,
    );
    if (repository === undefined) throw new ProjectCommandError("repository_unavailable");
    await this.database.setProjectGitHubConfigurationSource({
      projectId: tenant.project.id,
      githubConnectionId: repository.connectionId,
      githubRepositoryId: repository.repositoryId,
      githubRepositoryFullName: repository.fullName,
      githubDefaultBranch: repository.defaultBranch,
      automaticDeploymentEnabled: true,
      userId: account.account.id,
    });
  }

  async switchConfigurationToManual(request: Request, scope: ProjectRouteScope) {
    const { account, tenant } = await this.resolveProjectManager(request, scope);
    return new ProjectConfigurationStore(this.database, tenant.project.id).switchToManual(
      account.account.id,
    );
  }

  async saveManualConfiguration(request: Request, scope: ProjectRouteScope, rawYaml: string) {
    const { account, tenant } = await this.resolveProjectManager(request, scope);
    const status = await this.database.projectConfigurationReadModel(tenant.project.id);
    if (status.authority !== "manual") throw new ProjectCommandError("configuration_read_only");
    const store = new ProjectConfigurationStore(this.database, tenant.project.id);
    let rawConfiguration: unknown;
    try {
      rawConfiguration = load(rawYaml);
    } catch (error) {
      return this.database.insertProjectConfigurationRevision({
        projectId: tenant.project.id,
        sourceKind: "manual",
        sourceEvidence: { kind: "manual", userId: account.account.id },
        rawYaml,
        normalizedConfiguration: null,
        validationErrors: {
          formErrors: [error instanceof Error ? error.message : "invalid_yaml"],
        },
        contentHash: configurationHash(rawYaml),
        createdByUserId: account.account.id,
      });
    }
    const revision = await store.insertManualRevision({
      rawYaml,
      rawConfiguration,
      userId: account.account.id,
    });
    if (revision.validationErrors === null) await store.activate(revision.id);
    return revision;
  }

  async syncConfiguration(request: Request, scope: ProjectRouteScope) {
    const { tenant } = await this.resolveProjectManager(request, scope);
    if (this.github === undefined) throw new ProjectCommandError("github_sync_unavailable");
    const result = await synchronizeGitHubDefaultBranch({
      database: this.database,
      client: this.github,
      projectId: tenant.project.id,
      webhookDeliveryId: null,
    });
    if (result === undefined) throw new ProjectCommandError("github_sync_unavailable");
    return result;
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

export class ProjectCommandError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProjectCommandError";
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
    displayName: daemon.displayName,
    status: daemon.status,
    presence: daemon.presence,
    lastSeenAt: daemon.lastSeenAt.toISOString(),
  };
}

function connectionUsageView(
  connections: Awaited<ReturnType<Database["organizationConnectionUsage"]>>,
) {
  return {
    github: connections.github.map((connection) => ({
      id: connection.id,
      slug: connection.slug,
      installationId: connection.installationId,
      accountLogin: connection.accountLogin,
      status: connection.status,
    })),
    discord: connections.discord.map((connection) => ({
      id: connection.id,
      slug: connection.slug,
      guildId: connection.guildId,
      guildName: connection.guildName,
    })),
    slack: connections.slack.map((connection) => ({
      id: connection.id,
      slug: connection.slug,
      teamId: connection.teamId,
      teamName: connection.teamName,
    })),
  };
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
            rawYaml: active.rawYaml,
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

function triggerView(trigger: Awaited<ReturnType<Database["findTriggerById"]>> & {}) {
  if (trigger === undefined) throw new Error("trigger unavailable");
  return {
    id: trigger.id,
    source: trigger.source,
    repo: trigger.repo,
    receivedAt: trigger.receivedAt.toISOString(),
    matchedTriggerName: trigger.matchedTriggerName,
    droppedReason: trigger.droppedReason,
    lifecycleState: trigger.lifecycleState,
  };
}

function executionView(execution: Awaited<ReturnType<Database["findAgentExecutionById"]>> & {}) {
  if (execution === undefined) throw new Error("execution unavailable");
  return {
    id: execution.id,
    status: execution.status,
    startedAt: execution.startedAt.toISOString(),
    completedAt: execution.completedAt?.toISOString() ?? null,
    configurationRevisionId: execution.configurationRevisionId,
    daemonId: execution.daemonId,
  };
}
