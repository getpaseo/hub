import type { ProviderResources } from "../resources.js";
import { linearConnectionRequiresReauthorization } from "./client.js";
import { linearPersistence } from "./persistence.js";
export const resources: ProviderResources = {
  label: "Linear",
  triggerOrder: 3,
  async connections(database, organizationId) {
    return (await linearPersistence(database).listConnections(organizationId)).map(
      (connection) => ({
        id: connection.id,
        slug: connection.slug,
        label: connection.linearOrganizationName,
        description: `${connection.slug} "${connection.linearOrganizationName}"`,
        view: {
          id: connection.id,
          slug: connection.slug,
          linearOrganizationId: connection.linearOrganizationId,
          linearOrganizationName: connection.linearOrganizationName,
          requiresReauthorization: linearConnectionRequiresReauthorization(connection),
        },
      }),
    );
  },
  async configuration(database, organizationId) {
    const connections = await linearPersistence(database).listConnections(organizationId);
    return connections.map((connection) => ({
      slug: connection.slug,
      organizationName: connection.linearOrganizationName,
    }));
  },
  resource: {
    field: "project",
    label: "Linear project",
    replaceAuthored: true,
    async resolve(database, organizationId, value, allowed) {
      const connections = (
        await linearPersistence(database).listConnections(organizationId)
      ).filter((row) => allowed.has(row.id));
      if (connections.length !== 1) return undefined;
      return { connectionId: connections[0]!.id, resourceId: value };
    },
  },
};
