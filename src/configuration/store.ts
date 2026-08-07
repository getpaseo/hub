import { dump } from "js-yaml";
import { z } from "zod";
import {
  compileHubConfig,
  compiledConfigurationHash,
  parseCompiledHubConfig,
  rawConfigurationHash,
  type CompiledHubConfig,
  type CompiledTriggerFilter,
  type CompiledTrigger,
} from "../config/compiler.js";
import type { EnvironmentConfig } from "../config/schema.js";
import {
  resolvedPromptPartialsEvidence,
  type ResolvedPromptPartials,
} from "../config/prompt-partials.js";
import type {
  ConnectionProvider,
  Database,
  ProjectConfigurationRevisionRecord,
  ProjectTriggerRoute,
} from "../db/types.js";
import {
  configurationValidationErrors,
  type ConfigurationValidationErrors,
} from "./validation-errors.js";

export interface StoredProjectConfiguration {
  revision: ProjectConfigurationRevisionRecord;
  configuration: CompiledProjectConfiguration;
}

export type CompiledProjectConfiguration = Omit<CompiledHubConfig, "environments" | "triggers"> & {
  environments: readonly (
    | Exclude<EnvironmentConfig, { kind: "daemon" }>
    | (Extract<EnvironmentConfig, { kind: "daemon" }> & { daemonId: string })
  )[];
  triggers: readonly CompiledTrigger[];
};

function addPromptPartialsEvidence(
  sourceEvidence: unknown,
  resolvedPromptPartials: ResolvedPromptPartials | undefined,
): unknown {
  if (resolvedPromptPartials === undefined || resolvedPromptPartials.size === 0) {
    return sourceEvidence;
  }
  if (typeof sourceEvidence === "object" && sourceEvidence !== null) {
    return {
      ...sourceEvidence,
      partials: resolvedPromptPartialsEvidence(resolvedPromptPartials),
    };
  }
  return {
    sourceEvidence,
    partials: resolvedPromptPartialsEvidence(resolvedPromptPartials),
  };
}

export class ProjectConfigurationStore {
  constructor(
    private readonly database: Database,
    private readonly projectId: string,
  ) {}

  async insertManualRevision(input: {
    rawYaml: string | null;
    rawConfiguration: unknown;
    userId: string | null;
    sourceEvidence?: unknown;
    resolvedPromptPartials?: ResolvedPromptPartials;
  }): Promise<ProjectConfigurationRevisionRecord> {
    const prepared = await prepareRevision(
      this.database,
      this.projectId,
      input.rawConfiguration,
      input.resolvedPromptPartials,
    );
    return this.database.insertProjectConfigurationRevision({
      projectId: this.projectId,
      sourceKind: "manual",
      sourceEvidence: addPromptPartialsEvidence(
        input.sourceEvidence ?? {
          kind: "manual",
          userId: input.userId,
        },
        input.resolvedPromptPartials,
      ),
      rawYaml: input.rawYaml,
      normalizedConfiguration: prepared.normalizedConfiguration,
      ...(prepared.validationErrors === undefined
        ? {}
        : { validationErrors: prepared.validationErrors }),
      contentHash: prepared.contentHash,
      createdByUserId: input.userId,
    });
  }

  async insertGitHubRevision(input: {
    rawYaml: string;
    rawConfiguration: unknown;
    githubConnectionId: string;
    githubRepositoryId: number;
    githubRepositoryFullName: string;
    githubDefaultBranch: string;
    commitSha: string;
    path: string;
    webhookDeliveryId: string | null;
    resolvedPromptPartials?: ResolvedPromptPartials;
    validationErrors?: unknown;
  }): Promise<ProjectConfigurationRevisionRecord> {
    const prepared =
      input.validationErrors === undefined
        ? await prepareRevision(
            this.database,
            this.projectId,
            input.rawConfiguration,
            input.resolvedPromptPartials,
          )
        : {
            normalizedConfiguration: input.rawConfiguration,
            contentHash: rawConfigurationHash(input.rawConfiguration),
            validationErrors: input.validationErrors,
          };
    return this.database.insertProjectConfigurationRevision({
      projectId: this.projectId,
      sourceKind: "github",
      sourceEvidence: {
        kind: "github",
        githubConnectionId: input.githubConnectionId,
        githubRepositoryId: input.githubRepositoryId,
        githubRepositoryFullName: input.githubRepositoryFullName,
        githubDefaultBranch: input.githubDefaultBranch,
        commitSha: input.commitSha,
        path: input.path,
        webhookDeliveryId: input.webhookDeliveryId,
        ...(input.resolvedPromptPartials === undefined
          ? {}
          : {
              partials: resolvedPromptPartialsEvidence(input.resolvedPromptPartials),
            }),
      },
      rawYaml: input.rawYaml,
      normalizedConfiguration: prepared.normalizedConfiguration,
      ...(prepared.validationErrors === undefined
        ? {}
        : { validationErrors: prepared.validationErrors }),
      contentHash: prepared.contentHash,
    });
  }

  async activate(revisionId: string): Promise<StoredProjectConfiguration> {
    const candidate = await this.database.findProjectConfigurationRevision(
      this.projectId,
      revisionId,
    );
    if (candidate === undefined) throw new Error("configuration revision not found");
    const configuration = parseProjectConfiguration(candidate);
    const routes = await compileTriggerRoutes(this.database, this.projectId, configuration);
    const revision = await this.database.activateProjectConfigurationRevision(
      this.projectId,
      revisionId,
      routes,
    );
    return { revision, configuration };
  }

  async rollback(): Promise<StoredProjectConfiguration> {
    const target = await this.database.findProjectConfigurationRollbackTarget(this.projectId);
    if (target === undefined) throw new Error("configuration rollback target not found");
    const configuration = parseProjectConfiguration(target);
    const routes = await compileTriggerRoutes(this.database, this.projectId, configuration);
    const revision = await this.database.rollbackProjectConfiguration(
      this.projectId,
      target.id,
      routes,
    );
    return { revision, configuration };
  }

  async getActive(): Promise<StoredProjectConfiguration | undefined> {
    const revision = await this.database.findActiveProjectConfiguration(this.projectId);
    return revision === undefined
      ? undefined
      : { revision, configuration: parseProjectConfiguration(revision) };
  }

  async getRevision(revisionId: string): Promise<StoredProjectConfiguration | undefined> {
    const revision = await this.database.findProjectConfigurationRevision(
      this.projectId,
      revisionId,
    );
    return revision === undefined
      ? undefined
      : { revision, configuration: parseProjectConfiguration(revision) };
  }

  async switchToManual(userId: string): Promise<StoredProjectConfiguration> {
    const active = await this.database.findActiveProjectConfiguration(this.projectId);
    if (active === undefined) throw new Error("active configuration not found");
    const formattingPreserved = active.rawYaml !== null;
    const rawYaml =
      active.rawYaml ?? dump(active.normalizedConfiguration, { noRefs: true, lineWidth: -1 });
    const configuration = parseProjectConfiguration(active);
    const routes = await compileTriggerRoutes(this.database, this.projectId, configuration);
    const revision = await this.database.switchProjectConfigurationToManual({
      projectId: this.projectId,
      userId,
      rawYaml,
      normalizedConfiguration: active.normalizedConfiguration,
      contentHash: compiledConfigurationHash(configuration),
      formattingPreserved,
      routes,
    });
    return { revision, configuration: parseProjectConfiguration(revision) };
  }
}

export function parseProjectConfiguration(
  revision: ProjectConfigurationRevisionRecord,
): CompiledProjectConfiguration {
  return toProjectConfiguration(parseCompiledHubConfig(revision.normalizedConfiguration));
}

function toProjectConfiguration(configuration: CompiledHubConfig): CompiledProjectConfiguration {
  const environments = configuration.environments.map((environment) => {
    if (environment.kind !== "daemon") return environment;
    if (environment.daemonId === undefined) {
      throw new Error("active configuration contains an uncompiled daemon reference");
    }
    return { ...environment, daemonId: environment.daemonId };
  });
  return { environments, triggers: configuration.triggers };
}

async function prepareRevision(
  database: Database,
  projectId: string,
  rawConfiguration: unknown,
  resolvedPromptPartials?: ResolvedPromptPartials,
): Promise<PreparedRevision> {
  const compiled = await compileConfiguration(
    database,
    projectId,
    rawConfiguration,
    resolvedPromptPartials,
  );
  if (!compiled.success) {
    if (compiled.kind === "compiled") {
      return {
        kind: "compiled",
        normalizedConfiguration: compiled.configuration,
        contentHash: compiledConfigurationHash(compiled.configuration),
        validationErrors: compiled.validationErrors ?? {
          formErrors: [`unresolved organization resources: ${compiled.missing.join(", ")}`],
        },
      };
    }
    return {
      kind: "raw",
      normalizedConfiguration: rawConfiguration,
      contentHash: rawConfigurationHash(rawConfiguration),
      validationErrors: compiled.validationErrors,
    };
  }
  return {
    kind: "compiled",
    normalizedConfiguration: compiled.configuration,
    contentHash: compiledConfigurationHash(compiled.configuration),
  };
}

type PreparedRevision =
  | {
      kind: "compiled";
      normalizedConfiguration: CompiledHubConfig;
      contentHash: string;
      validationErrors?: unknown;
    }
  | {
      kind: "raw";
      normalizedConfiguration: unknown;
      contentHash: string;
      validationErrors: unknown;
    };

type CompileConfigurationResult =
  | { success: true; configuration: CompiledProjectConfiguration }
  | {
      success: false;
      kind: "compiled";
      configuration: CompiledHubConfig;
      missing: string[];
      validationErrors?: unknown;
    }
  | {
      success: false;
      kind: "raw";
      missing: string[];
      validationErrors: unknown;
    };

async function compileConfiguration(
  database: Database,
  projectId: string,
  rawConfiguration: unknown,
  resolvedPromptPartials?: ResolvedPromptPartials,
): Promise<CompileConfigurationResult> {
  let configuration: CompiledHubConfig;
  try {
    configuration = compileHubConfig(
      rawConfiguration,
      resolvedPromptPartials === undefined ? {} : { resolvedPromptPartials },
    );
  } catch (error) {
    return {
      success: false,
      kind: "raw",
      missing: [],
      validationErrors: formatConfigurationError(error),
    };
  }
  const project = await database.findProjectById(projectId);
  if (project === undefined) {
    return { success: false, kind: "compiled", missing: ["project"], configuration };
  }
  const resolutions = await Promise.all(
    configuration.environments.map(async (environment) =>
      environment.kind === "daemon"
        ? {
            environment,
            daemon: await database.findDaemonBySlugForOrganization(
              project.organizationId,
              environment.daemon,
            ),
          }
        : { environment, daemon: undefined },
    ),
  );
  const missing = resolutions.flatMap(({ environment, daemon }) =>
    environment.kind === "daemon" && daemon === undefined ? [environment.daemon] : [],
  );
  const triggerCompilation = await compileTriggers(
    database,
    project.organizationId,
    configuration.triggers,
  );
  const unresolved = [...missing, ...triggerCompilation.missing];
  if (unresolved.length > 0) {
    return { success: false, kind: "compiled", missing: unresolved, configuration };
  }
  const resolvedConfiguration: CompiledHubConfig = {
    ...configuration,
    environments: resolutions.map(resolveEnvironment),
    triggers: triggerCompilation.triggers,
  };
  return {
    success: true,
    configuration: toProjectConfiguration(parseCompiledHubConfig(resolvedConfiguration)),
  };
}

function formatConfigurationError(error: unknown): ConfigurationValidationErrors {
  if (error instanceof z.ZodError) return configurationValidationErrors(error);
  return {
    formErrors: [error instanceof Error ? error.message : "invalid configuration"],
    fieldErrors: {},
  };
}

function resolveEnvironment(
  resolution: EnvironmentResolution,
): CompiledHubConfig["environments"][number] {
  const { environment, daemon } = resolution;
  if (environment.kind !== "daemon" || daemon === undefined) return environment;
  return Object.assign({}, environment, { daemonId: daemon.id });
}

interface EnvironmentResolution {
  environment: CompiledHubConfig["environments"][number];
  daemon: { id: string } | undefined;
}

async function compileTriggerRoutes(
  database: Database,
  projectId: string,
  configuration: CompiledProjectConfiguration,
): Promise<ProjectTriggerRoute[]> {
  const project = await database.findProjectById(projectId);
  if (project === undefined) throw new Error("project not found");
  const routes = await compileTriggers(database, project.organizationId, configuration.triggers);
  if (routes.missing.length > 0)
    throw new Error(`unresolved organization resources: ${routes.missing.join(", ")}`);
  return routes.routes;
}

async function compileTriggers(
  database: Database,
  organizationId: string,
  triggers: readonly CompiledTrigger[],
): Promise<{ triggers: CompiledTrigger[]; routes: ProjectTriggerRoute[]; missing: string[] }> {
  const usage = await database.organizationConnectionUsage(organizationId);
  const compiled: CompiledTrigger[] = [];
  const routes: ProjectTriggerRoute[] = [];
  const missing: string[] = [];

  for (const trigger of triggers) {
    const provider = providerForEvent(trigger.on);
    if (provider === undefined) {
      compiled.push(trigger);
      continue;
    }
    const filter = trigger.filters;
    const authored = readAuthoredResource(provider, filter);
    const candidates = connectionCandidates(provider, usage, filter);
    const authoredConnection = filter?.connection;
    if (typeof authoredConnection === "string" && candidates.length === 0) {
      missing.push(`${provider}:connection:${authoredConnection}`);
      continue;
    }
    if (authored !== undefined) {
      const resolved = await resolveResource(
        database,
        organizationId,
        provider,
        authored,
        new Set(candidates.map((connection) => connection.id)),
      );
      if (resolved === undefined) {
        missing.push(`${provider}:${authored}`);
        continue;
      }
      const nextFilter: CompiledTriggerFilter = {
        ...filter,
        connectionId: resolved.connectionId,
        resourceId: resolved.resourceId,
      };
      compiled.push({ ...trigger, filters: nextFilter });
      routes.push({
        provider,
        connectionId: resolved.connectionId,
        resourceId: resolved.resourceId,
        triggerName: trigger.name,
      });
      continue;
    }

    const nextFilter: CompiledTriggerFilter | undefined =
      typeof authoredConnection === "string" && filter !== undefined
        ? { ...filter, connectionId: candidates[0]!.id }
        : filter;
    compiled.push({ ...trigger, ...(nextFilter === undefined ? {} : { filters: nextFilter }) });
    for (const connection of candidates) {
      routes.push({
        provider,
        connectionId: connection.id,
        resourceId: null,
        triggerName: trigger.name,
      });
    }
  }
  return { triggers: compiled, routes, missing };
}

function providerForEvent(eventName: string): ConnectionProvider | undefined {
  const provider = eventName.slice(0, eventName.indexOf("."));
  return provider === "github" || provider === "slack" || provider === "discord"
    ? provider
    : undefined;
}

function readAuthoredResource(
  provider: ConnectionProvider,
  filters: CompiledTrigger["filters"] | undefined,
): string | undefined {
  if (filters === undefined) return undefined;
  let value: string | undefined;
  if (provider === "github") value = filters.repo;
  else if (provider === "slack") value = filters.workspace;
  else value = filters.guild;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function connectionCandidates(
  provider: ConnectionProvider,
  usage: Awaited<ReturnType<Database["organizationConnectionUsage"]>>,
  filters: CompiledTrigger["filters"] | undefined,
) {
  const connections = usage[provider];
  const authoredSlug = filters?.["connection"];
  if (typeof authoredSlug !== "string") return connections;
  return connections.filter((connection) => connection.slug === authoredSlug);
}

async function resolveResource(
  database: Database,
  organizationId: string,
  provider: ConnectionProvider,
  resource: string,
  allowedConnectionIds: ReadonlySet<string>,
): Promise<{ connectionId: string; resourceId: string } | undefined> {
  if (provider === "github") {
    const repositories = (await database.listGitHubRepositories(organizationId)).filter(
      (repository) =>
        repository.fullName === resource && allowedConnectionIds.has(repository.connectionId),
    );
    if (repositories.length !== 1) return undefined;
    const repository = repositories[0]!;
    return { connectionId: repository.connectionId, resourceId: String(repository.repositoryId) };
  }
  if (provider === "slack") {
    const connection = await database.findSlackConnectionForOrganization(organizationId, resource);
    return connection === undefined || !allowedConnectionIds.has(connection.id)
      ? undefined
      : { connectionId: connection.id, resourceId: resource };
  }
  const connection = await database.findDiscordConnectionForOrganization(organizationId, resource);
  return connection === undefined || !allowedConnectionIds.has(connection.id)
    ? undefined
    : { connectionId: connection.id, resourceId: resource };
}
