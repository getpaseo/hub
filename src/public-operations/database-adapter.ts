import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../db/types.js";
import { DeploymentProjects } from "../project-deployments/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { PublicOperationRepository } from "./types.js";

export function createDatabasePublicOperationRepository(
  database: Database,
  providers: ProviderRegistry,
): PublicOperationRepository {
  const deploymentProjects = new DeploymentProjects(database);
  return {
    async listActiveProjects(organizationId) {
      return (await database.listProjectsForOrganization(organizationId))
        .filter((project) => project.status === "active")
        .map(({ id, name, slug }) => ({ id, name, slug }));
    },
    async listConfigurationResources(organizationId) {
      const [entries, daemons] = await Promise.all([
        Promise.all(
          orderedProviders(providers).map(
            async (module) =>
              [
                module.manifest.id,
                Array.from(await module.resources.configuration(database, organizationId)),
              ] as const,
          ),
        ),
        database.listDaemonsForOrganization(organizationId),
      ]);
      return {
        daemons: daemons
          .filter(
            ({ status, permissions }) => status === "active" && permissions.includes("hub.execute"),
          )
          .map(({ id, slug }) => ({ id, slug })),
        ...Object.fromEntries(entries),
      };
    },
    async listSetupResources(organizationId) {
      return Object.fromEntries(
        await Promise.all(
          orderedProviders(providers).flatMap((module) => {
            return module.resources.setup === undefined
              ? []
              : [
                  module.resources
                    .setup(database, organizationId)
                    .then((rows) => [module.manifest.id, Array.from(rows)] as const),
                ];
          }),
        ),
      );
    },
    async resolveManualRunProject(organizationId, triggerName, projectSlug) {
      const organizationTrigger = (await database.listOrganizationTriggers(organizationId)).find(
        ({ name }) => name === triggerName,
      );
      if (organizationTrigger !== undefined) {
        return organizationTrigger.enabled
          ? { status: "resolved", id: organizationTrigger.runtimeProjectId }
          : { status: "disabled" };
      }
      const project = await database.findProjectBySlugForOrganization(organizationId, projectSlug);
      return project === undefined || project.status !== "active"
        ? undefined
        : { status: "resolved", id: project.id };
    },
    resolveDeploymentProject: (input) => deploymentProjects.resolve(input),
    async findManualRun(providerEventReceiptId, trigger) {
      return (await database.findTriggerRunsByProviderEventReceiptId(providerEventReceiptId)).find(
        (candidate) => candidate.configuredTriggerName === trigger,
      );
    },
    async issueEnrollmentToken(authorization, input) {
      const issued = await database.issueEnrollmentToken({
        id: randomUUID(),
        verifier: createHash("sha256").update(input.token).digest("base64url"),
        organizationId: authorization.organizationId,
        ...(authorization.kind === "apiKey"
          ? { issuedByApiKeyId: authorization.credentialId }
          : { issuedByCliCredentialId: authorization.credentialId }),
        expiresAt: input.expiresAt,
        consumedAt: null,
      });
      return issued ? "issued" : "credential_revoked";
    },
  };
}

function orderedProviders(providers: ProviderRegistry) {
  return [...providers.list()].sort(
    (a, b) => (a.manifest.connectionOrder ?? 0) - (b.manifest.connectionOrder ?? 0),
  );
}
