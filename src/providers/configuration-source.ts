import type { QueryHandle } from "../db/runtime/index.js";
import type { ProviderResourceDatabase, ProviderResourceView } from "./resources.js";
export interface ProviderConfigurationSource {
  parseState(value: unknown): ProviderResourceView;
  latestAttempt(
    database: ProviderResourceDatabase,
    projectId: string,
  ): Promise<{ id: string; commitSha: string | null; outcome: string; createdAt: Date } | null>;
  repositories(
    database: ProviderResourceDatabase,
    organizationId: string,
  ): Promise<ProviderResourceView[]>;
  /** Transition the native source row atomically, preserving its stored shape constraint. */
  releaseToManual(transaction: QueryHandle, projectId: string): Promise<void>;
}
