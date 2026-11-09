import { z } from "zod";
import type { Database } from "../db/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ProviderResourceView } from "../providers/resources.js";
const manualStateSchema = z.object({ formattingPreserved: z.boolean() });
export async function projectConfigurationReadModel(
  database: Database,
  providers: ProviderRegistry,
  projectId: string,
) {
  const state = await database.readProjectConfigurationState(projectId);
  const attempts = await Promise.all(
    providers
      .list()
      .flatMap((module) =>
        module.configurationSource === undefined
          ? []
          : [module.configurationSource.latestAttempt(database, projectId)],
      ),
  );
  const lastSyncAttempt =
    attempts
      .filter((attempt) => attempt !== null)
      .sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
      )[0] ?? null;
  let sourceState: ProviderResourceView;
  if (state.source.kind === "manual")
    sourceState = { kind: "manual", ...manualStateSchema.parse(state.source.data) };
  else {
    const source = providers.require(state.source.kind).configurationSource;
    if (source === undefined) throw new Error("configuration source capability unavailable");
    sourceState = source.parseState(state.source.data);
  }
  return {
    authority: state.source.kind,
    activeRevision: state.activeRevision,
    lastSyncAttempt,
    sourceState,
  };
}
export async function configurationRepositories(
  database: Database,
  providers: ProviderRegistry,
  organizationId: string,
): Promise<ProviderResourceView[]> {
  return (
    await Promise.all(
      providers
        .list()
        .flatMap((module) =>
          module.configurationSource === undefined
            ? []
            : [module.configurationSource.repositories(database, organizationId)],
        ),
    )
  ).flat();
}
