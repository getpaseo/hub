import { and, eq, isNull, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import { ConnectionRepository } from "./connections.js";
import type {
  AcceptDiscordTriggerInput,
  AcceptGitHubTriggerInput,
  AcceptSlackTriggerInput,
  DurableTrigger,
  GitHubLifecycleClaim,
  GitHubLifecycleClaimInput,
  GitHubLifecycleResult,
  ManualTriggerPersistence,
  PersistManualTriggerInput,
  ProviderTriggerAcceptance,
  ProviderTriggerEvidence,
} from "./types.js";

type HubDatabase = NodePgDatabase<typeof schema>;
type HubTransaction = Parameters<Parameters<HubDatabase["transaction"]>[0]>[0];

const GITHUB_LIFECYCLE = "github_lifecycle";

export class TriggerAcceptanceRepository {
  constructor(
    private readonly database: HubDatabase,
    private readonly connections: ConnectionRepository,
  ) {}

  acceptGitHub(input: AcceptGitHubTriggerInput): Promise<ProviderTriggerAcceptance> {
    return this.acceptProvider("github", input.installationId, input.repositoryId, input);
  }

  acceptDiscord(input: AcceptDiscordTriggerInput): Promise<ProviderTriggerAcceptance> {
    return this.acceptProvider("discord", input.guildId, input.guildId, input);
  }

  acceptSlack(input: AcceptSlackTriggerInput): Promise<ProviderTriggerAcceptance> {
    return this.acceptProvider("slack", input.teamId, input.teamId, input);
  }

  private async acceptProvider(
    provider: "github" | "slack" | "discord",
    externalId: number | string,
    resourceId: number | string | undefined,
    input: ProviderTriggerEvidence,
  ): Promise<ProviderTriggerAcceptance> {
    return this.database.transaction(async (transaction) => {
      const connection = await findConnection(transaction, provider, externalId);
      if (connection === undefined) {
        return { status: "dropped", receiptId: input.deliveryId, reason: `${provider}_unbound` };
      }
      const existing = await findReceipt(transaction, input, connection.organizationId);
      if (existing !== undefined) return duplicateAcceptance(transaction, existing.id);
      const dropReason =
        input.dropReason ??
        (provider === "github" && "status" in connection && connection.status === "suspended"
          ? "github_suspended"
          : undefined);
      if (dropReason !== undefined) {
        const receipt = await claimProviderReceipt(transaction, {
          organizationId: connection.organizationId,
          provider,
          connectionId: connection.id,
          resourceId: resourceId === undefined ? null : String(resourceId),
          input: { ...input, dropReason },
        });
        if (!receipt.inserted) return duplicateAcceptance(transaction, receipt.id);
        return { status: "dropped", receiptId: receipt.id, reason: dropReason };
      }
      const receipt = await claimProviderReceipt(transaction, {
        organizationId: connection.organizationId,
        provider,
        connectionId: connection.id,
        resourceId: resourceId === undefined ? null : String(resourceId),
        input,
      });
      if (!receipt.inserted) return duplicateAcceptance(transaction, receipt.id);
      const routes = await transaction
        .select({
          projectId: schema.projectTriggerRoutes.projectId,
          revisionId: schema.projectTriggerRoutes.configurationRevisionId,
          triggerName: schema.projectTriggerRoutes.triggerName,
          connectionId: schema.projectTriggerRoutes.connectionId,
          resourceId: schema.projectTriggerRoutes.resourceId,
        })
        .from(schema.projectTriggerRoutes)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.projectTriggerRoutes.projectId),
            eq(schema.projects.organizationId, connection.organizationId),
            eq(schema.projects.status, "active"),
            eq(
              schema.projects.activeConfigurationRevisionId,
              schema.projectTriggerRoutes.configurationRevisionId,
            ),
          ),
        )
        .where(
          and(
            eq(schema.projectTriggerRoutes.organizationId, connection.organizationId),
            eq(schema.projectTriggerRoutes.provider, provider),
            eq(schema.projectTriggerRoutes.connectionId, connection.id),
            or(
              isNull(schema.projectTriggerRoutes.resourceId),
              eq(
                schema.projectTriggerRoutes.resourceId,
                resourceId === undefined ? "" : String(resourceId),
              ),
            ),
          ),
        );
      if (routes.length === 0) {
        await transaction
          .update(schema.providerEventReceipts)
          .set({ droppedReason: input.dropReason ?? `${provider}_unrouted` })
          .where(eq(schema.providerEventReceipts.id, receipt.id));
        return {
          status: "dropped",
          receiptId: receipt.id,
          reason: input.dropReason ?? `${provider}_unrouted`,
        };
      }

      const triggers = await insertProviderTriggers(
        transaction,
        connection,
        selectFirstRoutePerProject(routes),
        receipt.id,
        resourceId,
        input,
      );
      return { status: "accepted", triggers, receiptId: receipt.id };
    });
  }

  persistManual(input: PersistManualTriggerInput): Promise<ManualTriggerPersistence> {
    return this.database.transaction(async (transaction) => {
      const existing = await findReceipt(transaction, input, input.organizationId);
      if (existing !== undefined) {
        const [trigger] = await transaction
          .select({ id: schema.triggers.id })
          .from(schema.triggers)
          .where(eq(schema.triggers.receiptId, existing.id))
          .limit(1);
        if (trigger === undefined) throw new Error("manual trigger receipt unavailable");
        return { status: "duplicate", triggerId: trigger.id };
      }
      const receipt = await claimProviderReceipt(transaction, {
        organizationId: input.organizationId,
        provider: "manual",
        connectionId: null,
        resourceId: null,
        input,
      });
      if (!receipt.inserted) {
        const [trigger] = await transaction
          .select({ id: schema.triggers.id })
          .from(schema.triggers)
          .where(eq(schema.triggers.receiptId, receipt.id))
          .limit(1);
        if (trigger === undefined) throw new Error("manual trigger receipt unavailable");
        return { status: "duplicate", triggerId: trigger.id };
      }
      const [trigger] = await transaction
        .insert(schema.triggers)
        .values({
          organizationId: input.organizationId,
          projectId: input.projectId,
          configurationRevisionId: input.configurationRevisionId ?? null,
          receiptId: receipt.id,
          connectionId: input.connectionId ?? null,
          resourceId: input.resourceId ?? null,
          deliveryId: input.deliveryId,
          signatureHash: input.signatureHash ?? null,
          source: input.source,
          repo: input.repo ?? null,
          payload: input.payload,
          receivedAt: input.receivedAt,
          matchedTriggerName: input.matchedTriggerName ?? null,
        })
        .returning({ id: schema.triggers.id });
      if (trigger === undefined) throw new Error("manual trigger unavailable");
      return {
        status: "accepted",
        trigger: {
          triggerId: trigger.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          deliveryId: input.deliveryId,
          source: input.source,
          payload: input.payload,
          receivedAt: input.receivedAt,
          connectionId: input.connectionId ?? null,
          resourceId: input.resourceId ?? null,
        },
      };
    });
  }

  claimGitHubLifecycle(input: GitHubLifecycleClaimInput): Promise<GitHubLifecycleClaim> {
    return this.database.transaction(async (transaction) => {
      const [connection] = await transaction
        .select({
          id: schema.githubConnections.id,
          organizationId: schema.githubConnections.organizationId,
        })
        .from(schema.githubConnections)
        .where(eq(schema.githubConnections.installationId, input.installationId));
      if (connection === undefined) return { status: "duplicate", triggerId: input.deliveryId };
      const receipt = await claimProviderReceipt(transaction, {
        organizationId: connection.organizationId,
        provider: "github",
        connectionId: connection.id,
        resourceId: null,
        input: { ...input, dropReason: GITHUB_LIFECYCLE },
      });
      if (!receipt.inserted) {
        const [existingTrigger] = await transaction
          .select({ id: schema.triggers.id })
          .from(schema.triggers)
          .where(eq(schema.triggers.receiptId, receipt.id))
          .limit(1);
        if (existingTrigger !== undefined) {
          return { status: "duplicate", triggerId: existingTrigger.id };
        }
      }
      const [trigger] = await transaction
        .insert(schema.triggers)
        .values({
          organizationId: connection.organizationId,
          projectId: null,
          receiptId: receipt.id,
          connectionId: connection.id,
          deliveryId: input.deliveryId,
          signatureHash: input.signatureHash,
          source: input.source,
          payload: input.payload,
          receivedAt: input.receivedAt,
          droppedReason: GITHUB_LIFECYCLE,
        })
        .returning({ id: schema.triggers.id });
      if (trigger === undefined) return { status: "duplicate", triggerId: receipt.id };
      return { status: "claimed", triggerId: trigger.id, installationId: input.installationId };
    });
  }

  applyGitHubLifecycle(
    claim: Extract<GitHubLifecycleClaim, { status: "claimed" }>,
    result: GitHubLifecycleResult,
  ): Promise<void> {
    return this.database.transaction(async (transaction) => {
      const [evidence] = await transaction
        .select({ id: schema.triggers.id })
        .from(schema.triggers)
        .where(
          and(
            eq(schema.triggers.id, claim.triggerId),
            eq(schema.triggers.droppedReason, GITHUB_LIFECYCLE),
          ),
        )
        .for("update");
      if (evidence === undefined) return;
      if (result.status === "absent") {
        if (result.removeBinding) {
          await this.connections.removeGitHubByInstallationInTransaction(
            transaction,
            claim.installationId,
          );
        }
        return;
      }
      await transaction
        .update(schema.githubConnections)
        .set({
          accountId: result.identity.accountId,
          accountLogin: result.identity.accountLogin,
          accountType: result.identity.accountType,
          status: result.identity.status,
          suspendedAt: result.identity.status === "suspended" ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(schema.githubConnections.installationId, claim.installationId));
    });
  }

  async releaseGitHubLifecycleClaim(triggerId: string): Promise<void> {
    await this.database.delete(schema.triggers).where(eq(schema.triggers.id, triggerId));
  }
}

async function findReceipt(
  transaction: HubTransaction,
  input: ProviderTriggerEvidence,
  organizationId: string,
) {
  const [receipt] = await transaction
    .select({ id: schema.providerEventReceipts.id })
    .from(schema.providerEventReceipts)
    .where(
      and(
        eq(schema.providerEventReceipts.organizationId, organizationId),
        input.signatureHash === undefined || input.signatureHash === null
          ? eq(schema.providerEventReceipts.deliveryId, input.deliveryId)
          : or(
              eq(schema.providerEventReceipts.deliveryId, input.deliveryId),
              eq(schema.providerEventReceipts.signatureHash, input.signatureHash),
            ),
      ),
    )
    .limit(1);
  return receipt;
}

async function duplicateAcceptance(
  transaction: HubTransaction,
  receiptId: string,
): Promise<ProviderTriggerAcceptance> {
  const rows = await transaction
    .select({ id: schema.triggers.id })
    .from(schema.triggers)
    .where(eq(schema.triggers.receiptId, receiptId));
  return { status: "duplicate", triggerIds: rows.map((row) => row.id), receiptId };
}

async function findConnection(
  transaction: HubTransaction,
  provider: "github" | "slack" | "discord",
  externalId: number | string,
) {
  if (provider === "github") {
    const [row] = await transaction
      .select({
        id: schema.githubConnections.id,
        organizationId: schema.githubConnections.organizationId,
        status: schema.githubConnections.status,
      })
      .from(schema.githubConnections)
      .where(eq(schema.githubConnections.installationId, Number(externalId)))
      .limit(1);
    return row;
  }
  if (provider === "slack") {
    const [row] = await transaction
      .select({
        id: schema.slackConnections.id,
        organizationId: schema.slackConnections.organizationId,
      })
      .from(schema.slackConnections)
      .where(eq(schema.slackConnections.teamId, String(externalId)))
      .limit(1);
    return row;
  }
  const [row] = await transaction
    .select({
      id: schema.discordConnections.id,
      organizationId: schema.discordConnections.organizationId,
    })
    .from(schema.discordConnections)
    .where(eq(schema.discordConnections.guildId, String(externalId)))
    .limit(1);
  return row;
}

function selectFirstRoutePerProject<Route extends { projectId: string }>(
  routes: readonly Route[],
): Route[] {
  const selected = new Map<string, Route>();
  for (const route of routes) {
    if (!selected.has(route.projectId)) selected.set(route.projectId, route);
  }
  return [...selected.values()];
}

async function insertProviderTriggers(
  transaction: HubTransaction,
  connection: { id: string; organizationId: string },
  routes: readonly {
    projectId: string;
    revisionId: string;
    triggerName: string;
    connectionId: string;
  }[],
  receiptId: string,
  resourceId: number | string | undefined,
  input: ProviderTriggerEvidence,
): Promise<DurableTrigger[]> {
  const triggers: DurableTrigger[] = [];
  for (const route of routes) {
    const [trigger] = await transaction
      .insert(schema.triggers)
      .values({
        organizationId: connection.organizationId,
        projectId: route.projectId,
        configurationRevisionId: route.revisionId,
        receiptId,
        connectionId: route.connectionId,
        resourceId: resourceId === undefined ? null : String(resourceId),
        deliveryId: input.deliveryId,
        signatureHash: input.signatureHash ?? null,
        source: input.source,
        repo: input.repo ?? null,
        payload: input.payload,
        receivedAt: input.receivedAt,
        matchedTriggerName: route.triggerName,
      })
      .returning({ id: schema.triggers.id });
    if (trigger === undefined) throw new Error("provider trigger route unavailable");
    triggers.push({
      triggerId: trigger.id,
      organizationId: connection.organizationId,
      projectId: route.projectId,
      deliveryId: input.deliveryId,
      source: input.source,
      payload: input.payload,
      receivedAt: input.receivedAt,
      connectionId: route.connectionId,
      resourceId: resourceId === undefined ? null : String(resourceId),
    });
  }
  return triggers;
}

async function claimProviderReceipt(
  transaction: HubTransaction,
  input: {
    organizationId: string;
    provider: "github" | "slack" | "discord" | "manual";
    connectionId: string | null;
    resourceId: string | null;
    input: ProviderTriggerEvidence;
  },
): Promise<{ id: string; inserted: boolean }> {
  const [receipt] = await transaction
    .insert(schema.providerEventReceipts)
    .values({
      organizationId: input.organizationId,
      provider: input.provider,
      connectionId: input.connectionId,
      resourceId: input.resourceId,
      deliveryId: input.input.deliveryId,
      signatureHash: input.input.signatureHash ?? null,
      source: input.input.source,
      repo: input.input.repo ?? null,
      payload: input.input.payload,
      receivedAt: input.input.receivedAt,
      droppedReason: input.input.dropReason ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.providerEventReceipts.id });
  if (receipt !== undefined) return { id: receipt.id, inserted: true };

  const existing = await findReceipt(transaction, input.input, input.organizationId);
  if (existing === undefined) throw new Error("provider receipt unavailable");
  return { id: existing.id, inserted: false };
}
