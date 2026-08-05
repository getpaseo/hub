import { randomUUID } from "node:crypto";
import { compileHubConfig, compiledConfigurationHash } from "../config/compiler.js";
import {
  ProjectConfigurationStore,
  type CompiledProjectConfiguration,
} from "../configuration/store.js";
import type { Database, ProjectConfigurationRevisionRecord, ProjectRecord } from "../db/types.js";

export interface ActiveProjectConfigurationFixture {
  project: ProjectRecord;
  revision: ProjectConfigurationRevisionRecord;
  store: ProjectConfigurationStore;
}

export async function createActiveProjectConfiguration(
  database: Database,
  rawConfiguration: unknown,
  options: {
    organizationId?: string;
    projectSlug?: string;
    userId?: string;
  } = {},
): Promise<ActiveProjectConfigurationFixture> {
  const organizationId = options.organizationId ?? "org_1";
  const userId = options.userId ?? "test-user";
  const projectSlug = options.projectSlug ?? `project-${randomUUID()}`;
  const project = await database.createProject({
    organizationId,
    name: projectSlug,
    slug: projectSlug,
    createdByUserId: userId,
  });
  const configuration = compileTestDaemonReferences(rawConfiguration);
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: configuration,
    contentHash: compiledConfigurationHash(configuration),
    createdByUserId: userId,
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id);
  return {
    project,
    revision,
    store: new ProjectConfigurationStore(database, project.id),
  };
}

function compileTestDaemonReferences(rawConfiguration: unknown): CompiledProjectConfiguration {
  const configuration = compileHubConfig(rawConfiguration);
  return {
    ...configuration,
    environments: configuration.environments.map((environment) =>
      environment.kind === "daemon"
        ? Object.assign({}, environment, { daemonId: `daemon-${environment.daemon}` })
        : environment,
    ),
  };
}
