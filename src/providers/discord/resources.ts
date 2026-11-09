import type { ProviderResources } from "../resources.js";
import { discordPersistence } from "./persistence.js";
export const resources: ProviderResources = {
  connectionReferences: true,
  label: "Discord",
  triggerOrder: 1,
  async connections(database, organizationId) {
    return (await discordPersistence(database).listConnections(organizationId)).map(
      (connection) => ({
        id: connection.id,
        slug: connection.slug,
        label: connection.guildName,
        description: `${connection.slug} "${connection.guildName}"`,
        view: {
          id: connection.id,
          slug: connection.slug,
          guildId: connection.guildId,
          guildName: connection.guildName,
        },
      }),
    );
  },
  async configuration(database, organizationId) {
    const connections = await discordPersistence(database).listConnections(organizationId);
    return connections.map((connection) => ({
      slug: connection.slug,
      guildName: connection.guildName,
    }));
  },
  async setup(database, organizationId) {
    return (await discordPersistence(database).listConnections(organizationId)).map(
      (connection) => ({ guildId: connection.guildId, guildName: connection.guildName }),
    );
  },
  resource: {
    field: "guild",
    label: "Discord connection",
    replaceAuthored: true,
    async resolve(database, organizationId, value, allowed) {
      const connection = (await discordPersistence(database).listConnections(organizationId)).find(
        (row) => row.slug === value && allowed.has(row.id),
      );
      return connection === undefined
        ? undefined
        : { connectionId: connection.id, resourceId: connection.guildId };
    },
  },
};
