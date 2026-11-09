import type { ProviderResources } from "../resources.js";
import { githubPersistence } from "./persistence.js";
export const resources: ProviderResources = {
  connectionReferences: true,
  label: "GitHub",
  triggerOrder: 2,
  async connections(database, organizationId) {
    return (await githubPersistence(database).listConnections(organizationId)).map(
      (connection) => ({
        id: connection.id,
        slug: connection.slug,
        label: connection.accountLogin,
        description: connection.slug,
        view: {
          id: connection.id,
          slug: connection.slug,
          installationId: connection.installationId,
          accountLogin: connection.accountLogin,
          status: connection.status,
        },
      }),
    );
  },
  async configuration(database, organizationId) {
    const [connections, repositories] = await Promise.all([
      githubPersistence(database).listConnections(organizationId),
      githubPersistence(database).listGitHubRepositories(organizationId),
    ]);
    return connections.map((connection) => ({
      slug: connection.slug,
      accountLogin: connection.accountLogin,
      accountType: connection.accountType,
      repositories: repositories
        .filter((row) => row.connectionId === connection.id)
        .map((row) => row.fullName),
    }));
  },
  setup(database, organizationId) {
    return resources.configuration(database, organizationId);
  },
  resource: {
    field: "repo",
    label: "GitHub repository",
    async resolve(database, organizationId, value, allowed) {
      const repositories = (
        await githubPersistence(database).listGitHubRepositories(organizationId)
      ).filter((row) => row.fullName === value && allowed.has(row.connectionId));
      if (repositories.length !== 1) return undefined;
      const repository = repositories[0]!;
      return { connectionId: repository.connectionId, resourceId: String(repository.repositoryId) };
    },
    async candidates(database, organizationId, connections) {
      const allowed = new Set(connections.map((row) => row.id));
      return (await githubPersistence(database).listGitHubRepositories(organizationId))
        .filter((row) => allowed.has(row.connectionId))
        .map((row) => row.fullName);
    },
  },
};
