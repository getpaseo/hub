import type { ProviderResources } from "../resources.js";
import { hasRequiredSlackScopes } from "./client.js";
import { slackPersistence } from "./persistence.js";
export const resources: ProviderResources = {
  connectionReferences: true,
  label: "Slack",
  triggerOrder: 0,
  async connections(database, organizationId) {
    return (await slackPersistence(database).listConnections(organizationId)).map((connection) => ({
      id: connection.id,
      slug: connection.slug,
      label: connection.teamName,
      description: `${connection.slug} "${connection.teamName}"`,
      view: {
        id: connection.id,
        slug: connection.slug,
        teamId: connection.teamId,
        teamName: connection.teamName,
        requiresReauthorization: !hasRequiredSlackScopes(connection.scopes),
      },
    }));
  },
  async configuration(database, organizationId) {
    const connections = await slackPersistence(database).listConnections(organizationId);
    return connections.map((connection) => ({
      slug: connection.slug,
      teamName: connection.teamName,
    }));
  },
  async setup(database, organizationId) {
    return (await slackPersistence(database).listConnections(organizationId)).map((connection) => ({
      teamId: connection.teamId,
      teamName: connection.teamName,
    }));
  },
  resource: {
    field: "workspace",
    label: "Slack connection",
    replaceAuthored: true,
    async resolve(database, organizationId, value, allowed) {
      const connection = (await slackPersistence(database).listConnections(organizationId)).find(
        (row) => row.slug === value && allowed.has(row.id),
      );
      return connection === undefined
        ? undefined
        : { connectionId: connection.id, resourceId: connection.teamId };
    },
  },
};
