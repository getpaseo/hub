import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
import { getApplication } from "../server/runtime.js";
import { logger } from "../logger.js";
import { TenantRouteNotFoundError } from "./access.js";
import { ProjectCommandError, type ProjectDashboard } from "./dashboard.js";

const organizationScopeSchema = z
  .object({ organizationSlug: z.string().trim().min(1).max(100) })
  .strict();
const projectScopeSchema = organizationScopeSchema
  .extend({ projectSlug: z.string().trim().min(1).max(100) })
  .strict();
const createProjectSchema = organizationScopeSchema.extend({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    .max(100),
});
const projectSlugSchema = projectScopeSchema.extend({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    .max(100),
});
const configurationRepositorySchema = projectScopeSchema.extend({
  connectionId: z.string().uuid(),
  repositoryId: z.number().int().positive(),
});
const manualConfigurationSchema = projectScopeSchema.extend({ rawYaml: z.string().max(1_048_576) });
const triggerPayloadSchema = projectScopeSchema.extend({ triggerId: z.string().uuid() });
const executionResultSchema = projectScopeSchema.extend({ executionId: z.string().uuid() });

export const tenantContext = createServerFn({ method: "GET" })
  .validator(
    organizationScopeSchema.extend({ projectSlug: z.string().trim().min(1).max(100).optional() }),
  )
  .handler(
    async ({ data }): Promise<Result<Awaited<ReturnType<ProjectDashboard["tenantContext"]>>>> =>
      read(data, (dashboard) => dashboard.tenantContext(getRequest(), data)),
  );

export const organizationSnapshot = createServerFn({ method: "GET" })
  .validator(organizationScopeSchema)
  .handler(
    async ({
      data,
    }): Promise<Result<Awaited<ReturnType<ProjectDashboard["organizationSnapshot"]>>>> =>
      read(data, (dashboard) => dashboard.organizationSnapshot(getRequest(), data)),
  );

export const projectSnapshot = createServerFn({ method: "GET" })
  .validator(projectScopeSchema)
  .handler(
    async ({ data }): Promise<Result<Awaited<ReturnType<ProjectDashboard["projectSnapshot"]>>>> =>
      read(data, (dashboard) => dashboard.projectSnapshot(getRequest(), data)),
  );

export const createProject = createServerFn({ method: "POST" })
  .validator(createProjectSchema)
  .handler(async ({ data }) =>
    command(data, (dashboard) =>
      dashboard.createProject(getRequest(), data, { name: data.name, slug: data.slug }),
    ),
  );

export const archiveProject = createServerFn({ method: "POST" })
  .validator(projectScopeSchema)
  .handler(async ({ data }) =>
    command(data, (dashboard) => dashboard.archiveProject(getRequest(), data)),
  );

export const updateProjectSlug = createServerFn({ method: "POST" })
  .validator(projectSlugSchema)
  .handler(async ({ data }) =>
    command(data, (dashboard) => dashboard.updateProjectSlug(getRequest(), data, data.slug)),
  );

export const availableGitHubRepositories = createServerFn({ method: "GET" })
  .validator(projectScopeSchema)
  .handler(async ({ data }) =>
    read(data, (dashboard) => dashboard.availableGitHubRepositories(getRequest(), data)),
  );

export const useGitHubConfiguration = createServerFn({ method: "POST" })
  .validator(configurationRepositorySchema)
  .handler(async ({ data }) =>
    command(data, (dashboard) =>
      dashboard.useGitHubConfiguration(getRequest(), data, {
        connectionId: data.connectionId,
        repositoryId: data.repositoryId,
      }),
    ),
  );

export const switchConfigurationToManual = createServerFn({ method: "POST" })
  .validator(projectScopeSchema)
  .handler(async ({ data }) =>
    command(data, (dashboard) => dashboard.switchConfigurationToManual(getRequest(), data)),
  );

export const saveManualConfiguration = createServerFn({ method: "POST" })
  .validator(manualConfigurationSchema)
  .handler(async ({ data }) =>
    command(data, (dashboard) =>
      dashboard.saveManualConfiguration(getRequest(), data, data.rawYaml),
    ),
  );

export const triggerPayload = createServerFn({ method: "GET" })
  .validator(triggerPayloadSchema)
  .handler(async ({ data }) =>
    read(data, (dashboard) => dashboard.triggerPayload(getRequest(), data, data.triggerId)),
  );

export const executionResult = createServerFn({ method: "GET" })
  .validator(executionResultSchema)
  .handler(async ({ data }) =>
    read(data, (dashboard) => dashboard.executionResult(getRequest(), data, data.executionId)),
  );

export const syncProjectConfiguration = createServerFn({ method: "POST" })
  .validator(projectScopeSchema)
  .handler(async ({ data }) =>
    command(data, (dashboard) => dashboard.syncConfiguration(getRequest(), data)),
  );

async function read<T>(
  scope: { organizationSlug: string; projectSlug?: string | undefined },
  operation: (dashboard: ProjectDashboard) => Promise<T>,
): Promise<Result<T>> {
  try {
    return respondOk(await operation(await requireDashboard()));
  } catch (error) {
    logger.error({ err: error, scope }, "project dashboard read failed");
    return respondError({ message: unavailableMessage(error, scope.projectSlug !== undefined) });
  }
}

async function command<T>(
  scope: { organizationSlug: string; projectSlug?: string | undefined },
  operation: (dashboard: ProjectDashboard) => Promise<T>,
): Promise<Result<{ state: "complete" }>> {
  try {
    await operation(await requireDashboard());
    return respondOk({ state: "complete" });
  } catch (error) {
    if (error instanceof ProjectCommandError && error.code === "forbidden") {
      return respondError({ message: "You don't have permission to manage this project." });
    }
    logger.error({ err: error, scope }, "project dashboard command failed");
    return respondError({ message: unavailableMessage(error, scope.projectSlug !== undefined) });
  }
}

async function requireDashboard(): Promise<ProjectDashboard> {
  return (await getApplication()).projectDashboard ?? unavailable();
}

function unavailable(): never {
  throw new ProjectCommandError("dashboard_unavailable");
}

function unavailableMessage(error: unknown, projectScoped: boolean): string {
  if (error instanceof TenantRouteNotFoundError) {
    return projectScoped ? "Project unavailable." : "Organization unavailable.";
  }
  return projectScoped
    ? "We couldn't update this project."
    : "We couldn't update this organization.";
}
