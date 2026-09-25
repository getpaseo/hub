import { parseTriggerDocument } from "../triggers/configuration/index.js";
import { dump, load } from "js-yaml";
import { z } from "zod";
import {
  compiledConfigurationHash,
  parseCompiledHubConfig,
  type CompiledHubConfig,
  type CompiledTriggerFilter,
  type CompiledTrigger,
} from "../config/compiler.js";
import type { EnvironmentConfig } from "../config/schema.js";
import {
  compileHubBundle,
  HUB_RESOURCE_PATH,
  type CompiledHubBundle,
  type HubBundleAgentValidationTarget,
  type HubBundleFile,
} from "../config/bundle.js";
import { type PromptPartialBundleFile } from "../config/prompt-partials.js";
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
import { splitForgejoRepository } from "../triggers/forgejo/repository.js";

export interface StoredProjectConfiguration {
  revision: ProjectConfigurationRevisionRecord;
  configuration: CompiledProjectConfiguration;
}

/**
 * What compiling a Forgejo trigger's repo filter needs: proof the repository exists,
 * and the canonical full_name and numeric id to store instead of the raw authored
 * string. ForgejoApiClient satisfies this structurally, so this module never imports it.
 */
export interface ForgejoRepositoryResolver {
  getRepository(
    credentials: { instanceBaseUrl: string; accessToken: string },
    owner: string,
    repo: string,
  ): Promise<{ id: number; fullName: string } | undefined>;
}

export interface DaemonAgentConfigurationValidator {
  validateAgentConfiguration(
    daemonId: string,
    agent: import("../config/compiler.js").CompiledAgent,
  ): Promise<
    | { valid: true }
    | {
        valid: false;
        issues: readonly { path: readonly (string | number)[]; message: string }[];
      }
  >;
}

export type CompiledProjectConfiguration = Omit<CompiledHubConfig, "environments" | "triggers"> & {
  environments: readonly (
    | Exclude<EnvironmentConfig, { kind: "daemon" }>
    | (Extract<EnvironmentConfig, { kind: "daemon" }> & { daemonId: string })
  )[];
  triggers: readonly CompiledTrigger[];
};

const storedPromptPartialsSchema = z.object({
  partials: z.array(z.object({ path: z.string(), content: z.string() })),
});

const storedBundleSchema = z.object({
  bundle: z.object({
    authoredHash: z.string(),
    files: z.array(z.object({ path: z.string(), content: z.string() })),
  }),
});

export function revisionBundleFiles(
  revision: Pick<ProjectConfigurationRevisionRecord, "sourceEvidence">,
): readonly HubBundleFile[] {
  const parsed = storedBundleSchema.safeParse(revision.sourceEvidence);
  return parsed.success ? parsed.data.bundle.files : [];
}

function addBundleEvidence(sourceEvidence: unknown, bundle: CompiledHubBundle): unknown {
  const evidence = {
    authoredHash: bundle.authoredHash,
    files: bundle.files.map(({ path, content }) => ({ path, content })),
  };
  return typeof sourceEvidence === "object" && sourceEvidence !== null
    ? { ...sourceEvidence, bundle: evidence }
    : { sourceEvidence, bundle: evidence };
}

/**
 * The partial files a revision was built from, read back out of the evidence this
 * module writes. Revisions are immutable, so this is the authored source the
 * dashboard editor reopens — the compiled configuration inlines the same content.
 */
export function revisionPromptPartials(
  revision: Pick<ProjectConfigurationRevisionRecord, "sourceEvidence">,
): readonly PromptPartialBundleFile[] {
  const parsed = storedPromptPartialsSchema.safeParse(revision.sourceEvidence);
  return parsed.success ? parsed.data.partials : [];
}

export class ProjectConfigurationStore {
  constructor(
    private readonly database: Database,
    private readonly projectId: string,
    private readonly daemonAgentValidator?: DaemonAgentConfigurationValidator,
    private readonly forgejoRepositoryResolver?: ForgejoRepositoryResolver,
  ) {}

  async validateBundle(
    files: readonly HubBundleFile[],
  ): Promise<{ valid: true } | { valid: false; validationErrors: unknown }> {
    const project = await this.database.findProjectById(this.projectId);
    if (project === undefined) {
      return {
        valid: false,
        validationErrors: { formErrors: ["unresolved organization resources: project"] },
      };
    }
    return validateHubBundleForOrganization(
      this.database,
      project.organizationId,
      files,
      this.daemonAgentValidator,
      this.forgejoRepositoryResolver,
    );
  }

  async insertManualBundleRevision(input: {
    files: readonly HubBundleFile[];
    userId: string | null;
    sourceEvidence?: unknown;
  }): Promise<ProjectConfigurationRevisionRecord> {
    const bundle = compileHubBundle(input.files);
    const prepared = await prepareCompiledRevision(
      this.database,
      this.projectId,
      bundle.configuration,
      bundle.agentValidationTargets,
      this.daemonAgentValidator,
      this.forgejoRepositoryResolver,
    );
    return this.database.insertProjectConfigurationRevision({
      projectId: this.projectId,
      sourceKind: "manual",
      sourceEvidence: addBundleEvidence(
        input.sourceEvidence ?? { kind: "manual", userId: input.userId },
        bundle,
      ),
      rawYaml: bundle.files.find(({ path }) => path === HUB_RESOURCE_PATH)?.content ?? null,
      normalizedConfiguration: prepared.normalizedConfiguration,
      ...(prepared.validationErrors === undefined
        ? {}
        : { validationErrors: prepared.validationErrors }),
      contentHash: prepared.contentHash,
      createdByUserId: input.userId,
    });
  }

  async insertGitHubBundleRevision(input: {
    files: readonly HubBundleFile[];
    githubConnectionId: string;
    githubRepositoryId: number;
    githubRepositoryFullName: string;
    githubDefaultBranch: string;
    commitSha: string;
    webhookDeliveryId: string | null;
    validationErrors?: unknown;
  }): Promise<ProjectConfigurationRevisionRecord> {
    const bundle = compileHubBundle(input.files);
    const prepared =
      input.validationErrors === undefined
        ? await prepareCompiledRevision(
            this.database,
            this.projectId,
            bundle.configuration,
            bundle.agentValidationTargets,
            this.daemonAgentValidator,
            this.forgejoRepositoryResolver,
          )
        : {
            normalizedConfiguration: bundle.configuration,
            contentHash: bundle.authoredHash,
            validationErrors: input.validationErrors,
          };
    return this.database.insertProjectConfigurationRevision({
      projectId: this.projectId,
      sourceKind: "github",
      sourceEvidence: addBundleEvidence(
        {
          kind: "github",
          githubConnectionId: input.githubConnectionId,
          githubRepositoryId: input.githubRepositoryId,
          githubRepositoryFullName: input.githubRepositoryFullName,
          githubDefaultBranch: input.githubDefaultBranch,
          commitSha: input.commitSha,
          path: HUB_RESOURCE_PATH,
          webhookDeliveryId: input.webhookDeliveryId,
        },
        bundle,
      ),
      rawYaml: bundle.files.find(({ path }) => path === HUB_RESOURCE_PATH)?.content ?? null,
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
    const bundleFiles = revisionBundleFiles(candidate);
    if (bundleFiles.length === 0) {
      throw new Error("configuration revision has no authored bundle");
    }
    const bundle = compileHubBundle(bundleFiles);
    const validationErrors = await validateNamedAgents(
      configuration,
      bundle.agentValidationTargets,
      this.daemonAgentValidator,
    );
    if (validationErrors !== undefined) {
      throw new ConfigurationActivationValidationError(validationErrors);
    }
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
    const files = revisionBundleFiles(active);
    if (files.length === 0) throw new Error("active configuration has no authored bundle");
    const bundle = compileHubBundle(files);
    const rawYaml =
      bundle.files.find(({ path }) => path === HUB_RESOURCE_PATH)?.content ??
      dump(active.normalizedConfiguration, { noRefs: true, lineWidth: -1 });
    const configuration = parseProjectConfiguration(active);
    const routes = await compileTriggerRoutes(this.database, this.projectId, configuration);
    const revision = await this.database.switchProjectConfigurationToManual({
      projectId: this.projectId,
      userId,
      rawYaml,
      normalizedConfiguration: active.normalizedConfiguration,
      contentHash: compiledConfigurationHash(configuration),
      bundle: { authoredHash: bundle.authoredHash, files: bundle.files },
      routes,
    });
    return { revision, configuration: parseProjectConfiguration(revision) };
  }
}

export async function validateHubBundleForOrganization(
  database: Database,
  organizationId: string,
  files: readonly HubBundleFile[],
  daemonAgentValidator?: DaemonAgentConfigurationValidator,
  forgejoRepositoryResolver?: ForgejoRepositoryResolver,
): Promise<{ valid: true } | { valid: false; validationErrors: unknown }> {
  let bundle: CompiledHubBundle;
  try {
    bundle = compileHubBundle(files);
  } catch (error) {
    return { valid: false, validationErrors: formatConfigurationError(error) };
  }
  const prepared = await prepareCompiledRevisionForOrganization(
    database,
    organizationId,
    bundle.configuration,
    bundle.agentValidationTargets,
    daemonAgentValidator,
    forgejoRepositoryResolver,
  );
  return prepared.validationErrors === undefined
    ? { valid: true }
    : { valid: false, validationErrors: prepared.validationErrors };
}

export function parseProjectConfiguration(
  revision: ProjectConfigurationRevisionRecord,
): CompiledProjectConfiguration {
  const configuration = parseCompiledHubConfig(revision.normalizedConfiguration);
  // Migrate the newly introduced default at the authored-document boundary. Existing
  // execution launch intents remain untouched and finish with their original contract.
  const adapter = z
    .object({ kind: z.literal("organization_trigger_adapter") })
    .safeParse(revision.sourceEvidence);
  if (adapter.success) {
    if (revision.rawYaml === null)
      throw new Error("Trigger revision is missing its authored document");
    // Preserved legacy workflows share the adapter but retain their original run policy.
    const legacy = z.object({ legacy_multistep: z.object({}) }).safeParse(load(revision.rawYaml));
    if (legacy.success) return toProjectConfiguration(configuration);
    const policy = parseTriggerDocument(revision.rawYaml).run.continuation;
    return toProjectConfiguration({
      ...configuration,
      triggers: configuration.triggers.map((trigger) => ({
        ...trigger,
        steps: trigger.steps.map((step) => ({
          ...step,
          continuation: step.continuation ?? policy,
        })),
      })),
    });
  }
  return toProjectConfiguration(configuration);
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

async function prepareCompiledRevision(
  database: Database,
  projectId: string,
  configuration: CompiledHubConfig,
  agentValidationTargets: readonly HubBundleAgentValidationTarget[],
  daemonAgentValidator: DaemonAgentConfigurationValidator | undefined,
  forgejoRepositoryResolver: ForgejoRepositoryResolver | undefined,
): Promise<Extract<PreparedRevision, { kind: "compiled" }>> {
  const project = await database.findProjectById(projectId);
  if (project === undefined) {
    return {
      kind: "compiled",
      normalizedConfiguration: configuration,
      contentHash: compiledConfigurationHash(configuration),
      validationErrors: { formErrors: ["unresolved organization resources: project"] },
    };
  }
  return prepareCompiledRevisionForOrganization(
    database,
    project.organizationId,
    configuration,
    agentValidationTargets,
    daemonAgentValidator,
    forgejoRepositoryResolver,
  );
}

async function prepareCompiledRevisionForOrganization(
  database: Database,
  organizationId: string,
  configuration: CompiledHubConfig,
  agentValidationTargets: readonly HubBundleAgentValidationTarget[],
  daemonAgentValidator: DaemonAgentConfigurationValidator | undefined,
  forgejoRepositoryResolver: ForgejoRepositoryResolver | undefined,
): Promise<Extract<PreparedRevision, { kind: "compiled" }>> {
  const compiled = await resolveCompiledConfiguration(
    database,
    organizationId,
    configuration,
    forgejoRepositoryResolver,
  );
  if (!compiled.success) {
    return {
      kind: "compiled",
      normalizedConfiguration: compiled.configuration,
      contentHash: compiledConfigurationHash(compiled.configuration),
      validationErrors: compiled.validationErrors ?? { formErrors: [], issues: compiled.issues },
    };
  }
  const validationErrors = await validateNamedAgents(
    compiled.configuration,
    agentValidationTargets,
    daemonAgentValidator,
  );
  return {
    kind: "compiled",
    normalizedConfiguration: compiled.configuration,
    contentHash: compiledConfigurationHash(compiled.configuration),
    ...(validationErrors === undefined ? {} : { validationErrors }),
  };
}

export class ConfigurationActivationValidationError extends Error {
  constructor(readonly validationErrors: ConfigurationValidationErrors) {
    super("configuration is not valid for the selected daemon");
    this.name = "ConfigurationActivationValidationError";
  }
}

async function validateNamedAgents(
  configuration: CompiledProjectConfiguration,
  targets: readonly HubBundleAgentValidationTarget[],
  validator: DaemonAgentConfigurationValidator | undefined,
): Promise<ConfigurationValidationErrors | undefined> {
  if (targets.length === 0) return undefined;
  const daemonIdByEnvironment = new Map(
    configuration.environments.flatMap((environment) =>
      environment.kind === "daemon" ? [[environment.name, environment.daemonId] as const] : [],
    ),
  );
  if (validator === undefined) {
    return {
      formErrors: [],
      issues: [
        {
          path: [HUB_RESOURCE_PATH, "agents"],
          message: "the selected daemon provider-validation capability is unavailable",
        },
      ],
    };
  }
  const validations: Array<Promise<readonly { path: (string | number)[]; message: string }[]>> = [];
  for (const { name, agent, environmentNames } of targets) {
    for (const environmentName of environmentNames) {
      const daemonId = daemonIdByEnvironment.get(environmentName);
      if (daemonId === undefined) continue;
      validations.push(
        validator.validateAgentConfiguration(daemonId, agent).then(
          (result) =>
            result.valid
              ? []
              : result.issues.map((entry) => ({
                  path: [HUB_RESOURCE_PATH, "agents", name, ...entry.path],
                  message: entry.message,
                })),
          (error: unknown) => [
            {
              path: [HUB_RESOURCE_PATH, "agents", name],
              message:
                error instanceof Error
                  ? `selected daemon could not validate this agent: ${error.message}`
                  : "selected daemon could not validate this agent",
            },
          ],
        ),
      );
    }
  }
  const issues = (await Promise.all(validations)).flat();
  return issues.length === 0 ? undefined : { formErrors: [], issues };
}

interface PreparedRevision {
  kind: "compiled";
  normalizedConfiguration: CompiledHubConfig;
  contentHash: string;
  validationErrors?: unknown;
}

type CompileConfigurationResult =
  | { success: true; configuration: CompiledProjectConfiguration }
  | {
      success: false;
      kind: "compiled";
      configuration: CompiledHubConfig;
      issues: readonly { path: readonly (string | number)[]; message: string }[];
      validationErrors?: unknown;
    };

async function resolveCompiledConfiguration(
  database: Database,
  organizationId: string,
  configuration: CompiledHubConfig,
  forgejoRepositoryResolver: ForgejoRepositoryResolver | undefined,
): Promise<CompileConfigurationResult> {
  const daemons = (await database.listDaemonsForOrganization(organizationId)).filter(
    ({ status, permissions }) => status === "active" && permissions.includes("hub.execute"),
  );
  const resolutions = await Promise.all(
    configuration.environments.map(async (environment) =>
      environment.kind === "daemon"
        ? {
            environment,
            daemon: await database.findDaemonBySlugForOrganization(
              organizationId,
              environment.daemon,
            ),
          }
        : { environment, daemon: undefined },
    ),
  );
  const daemonIssues = resolutions.flatMap(({ environment, daemon }) =>
    environment.kind === "daemon" &&
    (daemon === undefined || !daemon.permissions.includes("hub.execute"))
      ? [
          {
            path: [HUB_RESOURCE_PATH, "environments", environment.name, "daemon"],
            message: `"${environment.daemon}" does not match any daemon (${formatCandidates(
              daemons.map(({ slug }) => slug),
            )})`,
          },
        ]
      : [],
  );
  const triggerCompilation = await compileTriggers(
    database,
    organizationId,
    configuration.triggers,
    forgejoRepositoryResolver,
  );
  const issues = [...daemonIssues, ...triggerCompilation.issues];
  if (issues.length > 0) {
    return { success: false, kind: "compiled", issues, configuration };
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

/** Organization-level seam used by the self-contained trigger store. */
export async function resolveTriggerConfigurationForOrganization(
  database: Database,
  organizationId: string,
  configuration: CompiledHubConfig,
  forgejoRepositoryResolver?: ForgejoRepositoryResolver,
): Promise<
  | {
      success: true;
      configuration: CompiledProjectConfiguration;
      routes: readonly {
        provider: ConnectionProvider;
        connectionId: string;
        resourceId: string | null;
        configuredEventName: string;
      }[];
    }
  | {
      success: false;
      configuration: CompiledHubConfig;
      issues: readonly { path: readonly (string | number)[]; message: string }[];
    }
> {
  const resolved = await resolveCompiledConfiguration(
    database,
    organizationId,
    configuration,
    forgejoRepositoryResolver,
  );
  if (!resolved.success) {
    return {
      success: false,
      configuration: resolved.configuration,
      issues: resolved.issues,
    };
  }
  // already carries connectionId+resourceId from the resolution above, so this second
  // pass never repeats a repository lookup.
  const compiled = await compileTriggers(
    database,
    organizationId,
    resolved.configuration.triggers,
    forgejoRepositoryResolver,
  );
  if (compiled.issues.length > 0) {
    return {
      success: false,
      configuration: resolved.configuration,
      issues: compiled.issues,
    };
  }
  const eventByInternalName = new Map(
    compiled.triggers.map((trigger) => [trigger.name, trigger.on] as const),
  );
  return {
    success: true,
    configuration: { ...resolved.configuration, triggers: compiled.triggers },
    routes: compiled.routes.map((route) => ({
      provider: route.provider,
      connectionId: route.connectionId,
      resourceId: route.resourceId,
      configuredEventName: eventByInternalName.get(route.triggerName) ?? route.triggerName,
    })),
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
  // no resolver: this only ever runs on a configuration already resolved at save time.
  const routes = await compileTriggers(database, project.organizationId, configuration.triggers);
  if (routes.issues.length > 0)
    throw new Error(routes.issues.map(({ message }) => message).join("; "));
  return routes.routes;
}

async function compileTriggers(
  database: Database,
  organizationId: string,
  triggers: readonly CompiledTrigger[],
  forgejoRepositoryResolver?: ForgejoRepositoryResolver,
): Promise<{
  triggers: CompiledTrigger[];
  routes: ProjectTriggerRoute[];
  issues: readonly { path: readonly (string | number)[]; message: string }[];
}> {
  const usage = await database.organizationConnectionUsage(organizationId);
  const compiled: CompiledTrigger[] = [];
  const routes: ProjectTriggerRoute[] = [];
  const issues: { path: readonly (string | number)[]; message: string }[] = [];

  for (const trigger of triggers) {
    const provider = providerForEvent(trigger.on);
    if (provider === undefined) {
      compiled.push(trigger);
      continue;
    }
    const filter = trigger.filters;
    if (filter?.connectionId !== undefined && filter.resourceId !== undefined) {
      compiled.push(trigger);
      routes.push({
        provider,
        connectionId: filter.connectionId,
        resourceId: filter.resourceId,
        triggerName: trigger.name,
      });
      continue;
    }
    const authored = readAuthoredResource(provider, filter);
    const candidates = connectionCandidates(provider, usage, filter);
    const authoredConnection = filter?.connection;
    if (typeof authoredConnection === "string" && candidates.length === 0) {
      issues.push({
        path: triggerFilterPath(trigger, "connection"),
        message: `"${authoredConnection}" does not match any ${providerLabel(provider)} connection (${formatConnectionCandidates(provider, usage[provider])})`,
      });
      continue;
    }
    if (authored !== undefined) {
      const result = await compileAuthoredResourceTrigger(
        database,
        organizationId,
        provider,
        trigger,
        filter,
        authored,
        candidates,
        forgejoRepositoryResolver,
      );
      if (result.kind === "issue") {
        issues.push(result.issue);
      } else {
        compiled.push(result.trigger);
        routes.push(result.route);
      }
      continue;
    }

    // no repo or connection filter: routing to every candidate would fire once per
    // connection, and two Forgejo connections on the same repo would double-fire.
    if (provider === "forgejo" && candidates.length > 1) {
      issues.push({
        path: triggerFilterPath(trigger, "connection"),
        message: `this trigger has no repo filter and matches more than one Forgejo connection (${formatConnectionCandidates(provider, candidates)}); add a connection filter to pick one`,
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
  return { triggers: compiled, routes, issues };
}

interface TriggerCompilationIssue {
  path: readonly (string | number)[];
  message: string;
}

/** The named-resource half of compileTriggers' per-trigger work, split out to keep
 * the main loop's own branching low enough for the complexity lint to pass. */
async function compileAuthoredResourceTrigger(
  database: Database,
  organizationId: string,
  provider: ConnectionProvider,
  trigger: CompiledTrigger,
  filter: CompiledTrigger["filters"],
  authored: string,
  candidates: ReturnType<typeof connectionCandidates>,
  forgejoRepositoryResolver: ForgejoRepositoryResolver | undefined,
): Promise<
  | { kind: "issue"; issue: TriggerCompilationIssue }
  | { kind: "compiled"; trigger: CompiledTrigger; route: ProjectTriggerRoute }
> {
  // a repo worth resolving but nothing to resolve it with: fail closed instead of
  // silently keeping the unresolved, unmatchable authored string on the filter.
  if (provider === "forgejo" && candidates.length > 0 && forgejoRepositoryResolver === undefined) {
    return {
      kind: "issue",
      issue: {
        path: triggerFilterPath(trigger, resourceField(provider)),
        message: "forgejo repository resolution is unavailable",
      },
    };
  }
  const resolved = await resolveResource(
    database,
    organizationId,
    provider,
    authored,
    new Set(candidates.map((connection) => connection.id)),
    forgejoRepositoryResolver,
  );
  if (resolved.status === "unreachable") {
    return {
      kind: "issue",
      issue: {
        path: triggerFilterPath(trigger, resourceField(provider)),
        message: `couldn't verify this ${resourceLabel(provider)} on ${resolved.instanceHost ?? "the instance"}: the instance could not be reached or refused the token`,
      },
    };
  }
  if (resolved.status === "not_found") {
    return {
      kind: "issue",
      issue: {
        path: triggerFilterPath(trigger, resourceField(provider)),
        message: `"${authored}" does not match any ${resourceLabel(provider)} (${await formatResourceCandidates(
          database,
          organizationId,
          provider,
          candidates,
        )})`,
      },
    };
  }
  if (resolved.status === "ambiguous") {
    return {
      kind: "issue",
      issue: {
        path: triggerFilterPath(trigger, "connection"),
        message: `"${authored}" matches more than one ${providerLabel(provider)} connection (${formatConnectionCandidates(provider, candidates)}); add a connection filter to pick one`,
      },
    };
  }
  const resolvedFilter = resolvedFilterFor(provider, filter, authored, resolved);
  const nextFilter: CompiledTriggerFilter = {
    ...resolvedFilter,
    connectionId: resolved.connectionId,
    resourceId: resolved.resourceId,
  };
  return {
    kind: "compiled",
    trigger: { ...trigger, filters: nextFilter },
    route: {
      provider,
      connectionId: resolved.connectionId,
      resourceId: resolved.resourceId,
      triggerName: trigger.name,
    },
  };
}

/** GitHub keeps the authored repo filter untouched, already the canonical fullName.
 * Forgejo replaces it with the resolved canonicalResource, since the authored string
 * can be a case difference or a rename the live lookup just canonicalized. */
function resolvedFilterFor(
  provider: ConnectionProvider,
  filter: CompiledTrigger["filters"],
  authored: string,
  resolved: Extract<ResourceResolution, { status: "resolved" }>,
): CompiledTrigger["filters"] {
  if (provider === "github") return filter;
  if (provider === "forgejo") return { ...filter, repo: resolved.canonicalResource ?? authored };
  return { ...filter, [resourceField(provider)]: resolved.resourceId };
}

function providerForEvent(eventName: string): ConnectionProvider | undefined {
  const provider = eventName.slice(0, eventName.indexOf("."));
  return provider === "github" ||
    provider === "slack" ||
    provider === "discord" ||
    provider === "linear" ||
    provider === "forgejo"
    ? provider
    : undefined;
}

function readAuthoredResource(
  provider: ConnectionProvider,
  filters: CompiledTrigger["filters"] | undefined,
): string | undefined {
  if (filters === undefined) return undefined;
  let value: string | undefined;
  if (provider === "github" || provider === "forgejo") value = filters.repo;
  else if (provider === "slack") value = filters.workspace;
  else if (provider === "discord") value = filters.guild;
  else value = filters.project;
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

/** A confirmed resource, or why none was. ambiguous is Forgejo-only: two accounts
 * sharing an instance can both see the same repo, a real match, not a typo, so it
 * gets its own status instead of folding into not_found like the other providers do.
 * unreachable is also Forgejo-only (the only live network lookup) and only fires when
 * nothing confirmed the resource and at least one candidate's lookup threw. */
type ResourceResolution =
  | { status: "resolved"; connectionId: string; resourceId: string; canonicalResource?: string }
  | { status: "not_found" }
  | { status: "ambiguous" }
  | { status: "unreachable"; instanceHost: string | undefined };

async function resolveResource(
  database: Database,
  organizationId: string,
  provider: ConnectionProvider,
  resource: string,
  allowedConnectionIds: ReadonlySet<string>,
  forgejoRepositoryResolver?: ForgejoRepositoryResolver,
): Promise<ResourceResolution> {
  if (provider === "github") {
    const repositories = (await database.listGitHubRepositories(organizationId)).filter(
      (repository) =>
        repository.fullName === resource && allowedConnectionIds.has(repository.connectionId),
    );
    if (repositories.length !== 1) return { status: "not_found" };
    const repository = repositories[0]!;
    return {
      status: "resolved",
      connectionId: repository.connectionId,
      resourceId: String(repository.repositoryId),
    };
  }
  if (provider === "slack") {
    const connection = (await database.organizationConnectionUsage(organizationId)).slack.find(
      ({ id, slug }) => slug === resource && allowedConnectionIds.has(id),
    );
    return connection === undefined
      ? { status: "not_found" }
      : { status: "resolved", connectionId: connection.id, resourceId: connection.teamId };
  }
  if (provider === "linear") {
    const connections = (await database.organizationConnectionUsage(organizationId)).linear.filter(
      ({ id }) => allowedConnectionIds.has(id),
    );
    if (connections.length !== 1) return { status: "not_found" };
    return { status: "resolved", connectionId: connections[0]!.id, resourceId: resource };
  }
  if (provider === "forgejo") {
    return resolveForgejoRepository(
      database,
      organizationId,
      resource,
      allowedConnectionIds,
      forgejoRepositoryResolver,
    );
  }
  const connection = (await database.organizationConnectionUsage(organizationId)).discord.find(
    ({ id, slug }) => slug === resource && allowedConnectionIds.has(id),
  );
  return connection === undefined
    ? { status: "not_found" }
    : { status: "resolved", connectionId: connection.id, resourceId: connection.guildId };
}

/**
 * Forgejo has no synced repository table, so this validates live against every candidate
 * connection's instance. More than one confirming connection stays ambiguous, since the repo
 * really does exist on both. A lookup that throws only counts against the resource when nothing
 * else confirmed it either, so an unreachable instance doesn't get reported as a typo.
 */
async function resolveForgejoRepository(
  database: Database,
  organizationId: string,
  resource: string,
  allowedConnectionIds: ReadonlySet<string>,
  forgejoRepositoryResolver: ForgejoRepositoryResolver | undefined,
): Promise<ResourceResolution> {
  if (forgejoRepositoryResolver === undefined) return { status: "not_found" };
  let owner: string;
  let name: string;
  try {
    [owner, name] = splitForgejoRepository(resource);
  } catch {
    return { status: "not_found" };
  }
  const candidates = (await database.organizationConnectionUsage(organizationId)).forgejo.filter(
    (connection) => allowedConnectionIds.has(connection.id),
  );
  let failedInstanceHost: string | undefined;
  const found = await Promise.all(
    candidates.map(async (connection) => {
      try {
        return await forgejoRepositoryResolver.getRepository(
          { instanceBaseUrl: connection.instanceBaseUrl, accessToken: connection.accessToken },
          owner,
          name,
        );
      } catch {
        failedInstanceHost ??= connection.instanceHost;
        return undefined;
      }
    }),
  );
  const matches = candidates.flatMap((connection, index) => {
    const repository = found[index];
    return repository === undefined ? [] : [{ connection, repository }];
  });
  if (matches.length === 1) {
    const match = matches[0]!;
    return {
      status: "resolved",
      connectionId: match.connection.id,
      resourceId: String(match.repository.id),
      canonicalResource: match.repository.fullName,
    };
  }
  if (matches.length > 1) return { status: "ambiguous" };
  if (matches.length === 0 && failedInstanceHost !== undefined) {
    return { status: "unreachable", instanceHost: failedInstanceHost };
  }
  return { status: "not_found" };
}

function triggerFilterPath(trigger: CompiledTrigger, field: string): readonly (string | number)[] {
  return [trigger.sourceFile ?? ".paseo/workflows", "filters", field];
}

function resourceField(provider: ConnectionProvider): "repo" | "workspace" | "guild" | "project" {
  if (provider === "github" || provider === "forgejo") return "repo";
  if (provider === "slack") return "workspace";
  if (provider === "discord") return "guild";
  return "project";
}

function providerLabel(provider: ConnectionProvider): string {
  if (provider === "github") return "GitHub";
  if (provider === "slack") return "Slack";
  if (provider === "discord") return "Discord";
  return provider === "linear" ? "Linear" : "Forgejo";
}

function resourceLabel(provider: ConnectionProvider): string {
  if (provider === "github") return "GitHub repository";
  if (provider === "linear") return "Linear project";
  if (provider === "forgejo") return "Forgejo repository";
  return `${providerLabel(provider)} connection`;
}

function formatCandidates(candidates: readonly string[]): string {
  return candidates.length === 0 ? "connected: none" : `connected: ${candidates.join(", ")}`;
}

function formatConnectionCandidates(
  provider: ConnectionProvider,
  connections: readonly {
    id: string;
    slug: string;
    guildName?: string;
    teamName?: string;
    linearOrganizationName?: string;
    accountLogin?: string;
  }[],
): string {
  return formatCandidates(
    connections.map((connection) => {
      if (provider === "discord" && connection.guildName !== undefined)
        return `${connection.slug} "${connection.guildName}"`;
      if (provider === "slack" && connection.teamName !== undefined)
        return `${connection.slug} "${connection.teamName}"`;
      if (provider === "linear" && connection.linearOrganizationName !== undefined)
        return `${connection.slug} "${connection.linearOrganizationName}"`;
      if (provider === "forgejo" && connection.accountLogin !== undefined)
        return `${connection.slug} "${connection.accountLogin}"`;
      return connection.slug;
    }),
  );
}

async function formatResourceCandidates(
  database: Database,
  organizationId: string,
  provider: ConnectionProvider,
  connections: readonly {
    id: string;
    slug: string;
    guildName?: string;
    teamName?: string;
    linearOrganizationName?: string;
    accountLogin?: string;
  }[],
): Promise<string> {
  if (provider !== "github") return formatConnectionCandidates(provider, connections);
  const connectionIds = new Set(connections.map(({ id }) => id));
  return formatCandidates(
    (await database.listGitHubRepositories(organizationId))
      .filter(({ connectionId }) => connectionIds.has(connectionId))
      .map(({ fullName }) => fullName),
  );
}
