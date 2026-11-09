import type { MemoryDatabaseOptions } from "./memory.js";
import type { DatabaseRuntime } from "./runtime/index.js";
import type { Locks } from "./runtime/locks/index.js";
import type { ProviderEventAcceptanceRepository } from "./trigger-acceptance.js";
import type {
  ConnectionProvider,
  Database,
  ProviderEventAcceptance,
  ProviderEventEvidence,
  ProviderEventReceiptRecord,
} from "./types.js";

export interface PostgresProviderContext {
  runtime: DatabaseRuntime;
  locks: Locks;
  events: ProviderEventAcceptanceRepository;
}
export interface MemoryProviderContext {
  findProjectById(projectId: string): import("./types.js").ProjectRecord | undefined;
  options: MemoryDatabaseOptions;
  withLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
  accept(
    provider: ConnectionProvider,
    input: ProviderEventEvidence,
    organizationId: string | undefined,
    connectionId: string | undefined,
    resourceId: string | null,
    reason: string | undefined,
  ): Promise<ProviderEventAcceptance>;
  findReceiptId(
    organizationId: string,
    deliveryId: string,
    signatureHash: string | null | undefined,
  ): string | undefined;
  insertReceipt(input: {
    organizationId: string;
    provider: ProviderEventReceiptRecord["provider"];
    connectionId: string | null;
    resourceId: string | null;
    input: {
      deliveryId: string;
      signatureHash?: string | null;
      providerApplicationId?: string | null;
      providerConfigurationVersion?: number | null;
      source: string;
      repo?: string | null;
      payload: unknown;
      receivedAt: Date;
      dropReason?: string;
    };
  }): ProviderEventReceiptRecord;
  removeConnectionReferences(connectionId: string): void;
  configurationSource(
    projectId: string,
  ): import("./types.js").ProjectConfigurationReadModel["sourceState"] | undefined;
  configurationSources(): readonly {
    projectId: string;
    source: import("./types.js").ProjectConfigurationReadModel["sourceState"];
  }[];
}
export interface ProviderPersistenceFactory<T> {
  postgres(context: PostgresProviderContext): T;
  memory(context: MemoryProviderContext): T;
}
export interface ProviderPersistenceHost {
  create<T>(factory: ProviderPersistenceFactory<T>): T;
}

/** A typed provider-owned repository, scoped to a database lifetime. */
export class ProviderPersistence<T> {
  private readonly instances = new WeakMap<ProviderPersistenceHost, T>();
  constructor(private readonly factory: ProviderPersistenceFactory<T>) {}
  for(database: Pick<Database, "providerPersistence">): T {
    const host = database.providerPersistence;
    let instance = this.instances.get(host);
    if (instance === undefined) {
      instance = host.create(this.factory);
      this.instances.set(host, instance);
    }
    return instance;
  }
}
