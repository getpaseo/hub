import { createMemoryDatabase, type MemoryDatabaseOptions } from "../memory.js";
import type { Database, ForgejoConnectionRecord } from "../types.js";

export const MEMORY_FORGEJO_CONNECTION_ID = "11111111-2222-4333-8444-555555555555";

// a memory database with one forgejo connection and one active route on repository 9001,
// so acceptForgejoEvent accepts instead of dropping. the memory store can't bind a
// connection itself, so the lookup is stubbed, same as configuration/store.test.ts.
export async function createForgejoRoutedMemoryDatabase(
  options: MemoryDatabaseOptions & { webhookSecret?: string } = {},
): Promise<Database> {
  const database = createMemoryDatabase(options);
  const connection: ForgejoConnectionRecord = {
    id: MEMORY_FORGEJO_CONNECTION_ID,
    organizationId: "org-forgejo",
    slug: "forge",
    instanceBaseUrl: "https://git.example.test",
    instanceHost: "git.example.test",
    webhookSecret: options.webhookSecret ?? "hook-secret",
    accessToken: "forgejo-access-token",
    accountLogin: "trillian",
    accountId: 42,
    instanceFlavor: "forgejo",
    instanceVersion: "16.0.5+gitea-1.22.0",
  };
  database.findForgejoConnection = (id) =>
    Promise.resolve(id === connection.id ? connection : undefined);
  const project = await database.createProject({
    organizationId: connection.organizationId,
    name: "Default",
    slug: "default",
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "forgejo-memory-config",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, [
    {
      provider: "forgejo",
      connectionId: connection.id,
      resourceId: "9001",
      triggerName: "forgejo-issue-comment",
    },
  ]);
  return database;
}
