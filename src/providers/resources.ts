import type { JsonValue } from "../config/schema.js";
import type { Database } from "../db/types.js";
export type ProviderResourceDatabase = Pick<Database, "providerPersistence">;
export interface ProviderResourceView {
  [key: string]: JsonValue;
}
export interface ProviderResourceConnection {
  id: string;
  slug: string;
  label: string;
  description: string;
  view: ProviderResourceView;
}
export interface ProviderResources {
  /** Bindings whose names participate in execution connection references. */
  connectionReferences?: true;
  label: string;
  triggerOrder: number;
  connections(
    database: ProviderResourceDatabase,
    organizationId: string,
  ): Promise<readonly ProviderResourceConnection[]>;
  configuration(
    database: ProviderResourceDatabase,
    organizationId: string,
  ): Promise<readonly ProviderResourceView[]>;
  setup?(
    database: ProviderResourceDatabase,
    organizationId: string,
  ): Promise<readonly ProviderResourceView[]>;
  resource: {
    field: string;
    label: string;
    replaceAuthored?: true;
    resolve(
      database: ProviderResourceDatabase,
      organizationId: string,
      value: string,
      allowed: ReadonlySet<string>,
    ): Promise<{ connectionId: string; resourceId: string } | undefined>;
    candidates?(
      database: ProviderResourceDatabase,
      organizationId: string,
      connections: readonly ProviderResourceConnection[],
    ): Promise<readonly string[]>;
  };
}

export async function organizationConnections(
  database: ProviderResourceDatabase,
  registry: import("./registry.js").ProviderRegistry,
  organizationId: string,
) {
  return Promise.all(
    registry.list().map(async (module) => ({
      provider: module.manifest.id,
      connections: await module.resources.connections(database, organizationId),
    })),
  );
}
