import type { Database } from "../../db/types.js";
import type {
  ForgejoAuthoritySnapshot,
  ForgejoExecutionAuthorityStore,
} from "./execution-authority.js";

export function createDatabaseForgejoAuthorityStore(
  database: Database,
): ForgejoExecutionAuthorityStore {
  return {
    async loadSnapshot(input) {
      const project = await database.findProjectById(input.projectId);
      if (project === undefined) return undefined;
      const directory = database.forgejoDirectory();
      const connections = await directory.listConnectionsForOrganization(project.organizationId);
      const connection = connections.find((candidate) => candidate.slug === input.connectionSlug);
      if (connection === undefined) return undefined;
      const instance = await directory.findInstanceById(connection.instanceId);
      if (instance === undefined) return undefined;
      const repositories = await directory.listRepositoriesForConnection(connection.id);
      const executionCredential = await directory.findActiveExecutionCredential(connection.id);
      const snapshot: ForgejoAuthoritySnapshot = {
        connection: {
          id: connection.id,
          organizationId: connection.organizationId,
          slug: connection.slug,
          status: connection.status,
          forgejoUserId: connection.forgejoUserId,
          forgejoUserLogin: connection.forgejoUserLogin,
          instanceId: connection.instanceId,
        },
        instance: {
          id: instance.id,
          canonicalOrigin: instance.canonicalOrigin,
          status: instance.status,
        },
        enrolledRepositories: repositories
          .filter((repository) => repository.enrolled)
          .map((repository) => repository.fullName),
        executionCredential,
      };
      return snapshot;
    },
  };
}
