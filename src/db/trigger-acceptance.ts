import { and, eq, isNull, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import { ConnectionRepository } from "./connections.js";
import type {
  AcceptDiscordEventInput,
  AcceptGitHubEventInput,
  AcceptSlackEventInput,
  GitHubLifecycleReceiptClaim,
  GitHubLifecycleReceiptClaimInput,
  GitHubLifecycleResult,
  ManualEventPersistence,
  PersistManualEventInput,
  ProviderEventAcceptance,
  ProviderEventEvidence,
} from "./types.js";

type HubDatabase = NodePgDatabase<typeof schema>;
type HubTransaction = Parameters<Parameters<HubDatabase["transaction"]>[0]>[0];

const GITHUB_LIFECYCLE = "github_lifecycle";

export class ProviderEventAcceptanceRepository {
  constructor(
    private readonly database: HubDatabase,
    private readonly connections: ConnectionRepository,
  ) {}

  acceptGitHub(input: AcceptGitHubEventInput): Promise<ProviderEventAcceptance> {
    return this.acceptProvider("github", input.installationId, input.repositoryId, input);
  }

  acceptDiscord(input: AcceptDiscordEventInput): Promise<ProviderEventAcceptance> {
    return this.acceptProvider("discord", input.guildId, input.guildId, input);
  }

  acceptSlack(input: AcceptSlackEventInput): Promise<ProviderEventAcceptance> {
    return this.acceptProvider("slack", input.teamId, input.teamId, input);
  }

  private async acceptProvider(
    provider: "github" | "slack" | "discord",
    externalId: number | string,
    resourceId: number | string | undefined,
    input: ProviderEventEvidence,
  ): Promise<ProviderEventAcceptance> {
    return this.database.transaction(async (transaction) => {
      const connection = await findConnection(transaction, provider, externalId);
      if (connection === undefined) {
        return { status: "dropped", receiptId: input.deliveryId, reason: `${provider}_unbound` };
      }

      const existing = await findReceipt(transaction, input, connection.organizationId);
      if (existing !== undefined) return { status: "duplicate", receiptId: existing.id };

      const dropReason =
        input.dropReason ??
        (provider === "github" && "status" in connection && connection.status === "suspended"
          ? "github_suspended"
          : undefined);
      const receipt = await claimProviderReceipt(transaction, {
        organizationId: connection.organizationId,
        provider,
        connectionId: connection.id,
        resourceId: resourceId === undefined ? null : String(resourceId),
        input: dropReason === undefined ? input : { ...input, dropReason },
      });
      if (!receipt.inserted) return { status: "duplicate", receiptId: receipt.id };
      if (dropReason !== undefined) {
        return { status: "dropped", receiptId: receipt.id, reason: dropReason };
      }

      const routes = await transaction
        .select({
          projectId: schema.projectTriggerRoutes.projectId,
          revisionId: schema.projectTriggerRoutes.configurationRevisionId,
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

      const selectedRoutes = selectFirstRoutePerProject(routes);
      if (selectedRoutes.length === 0) {
        const reason = `${provider}_unrouted`;
        await transaction
          .update(schema.providerEventReceipts)
          .set({ droppedReason: reason })
          .where(eq(schema.providerEventReceipts.id, receipt.id));
        return { status: "dropped", receiptId: receipt.id, reason };
      }

      return {
        status: "accepted",
        events: selectedRoutes.map((route) => ({
          providerEventReceiptId: receipt.id,
          organizationId: connection.organizationId,
          projectId: route.projectId,
          deliveryId: input.deliveryId,
          source: input.source,
          payload: input.payload,
          receivedAt: input.receivedAt,
          connectionId: route.connectionId,
          resourceId: route.resourceId,
        })),
        receiptId: receipt.id,
      };
    });
  }

  persistManual(input: PersistManualEventInput): Promise<ManualEventPersistence> {
    return this.database.transaction(async (transaction) => {
      const existing = await findReceipt(transaction, input, input.organizationId);
      if (existing !== undefined) {
        return { status: "duplicate", providerEventReceiptId: existing.id };
      }
      const receipt = await claimProviderReceipt(transaction, {
        organizationId: input.organizationId,
        provider: "manual",
        connectionId: null,
        resourceId: null,
        input,
      });
      if (!receipt.inserted) {
        return { status: "duplicate", providerEventReceiptId: receipt.id };
      }
      return {
        status: "accepted",
        event: {
          providerEventReceiptId: receipt.id,
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

  claimGitHubLifecycleReceipt(
    input: GitHubLifecycleReceiptClaimInput,
  ): Promise<GitHubLifecycleReceiptClaim> {
    return this.database.transaction(async (transaction) => {
      const [connection] = await transaction
        .select({
          id: schema.githubConnections.id,
          organizationId: schema.githubConnections.organizationId,
        })
        .from(schema.githubConnections)
        .where(eq(schema.githubConnections.installationId, input.installationId));
      if (connection === undefined) {
        return { status: "duplicate", providerEventReceiptId: input.deliveryId };
      }
      const receipt = await claimProviderReceipt(transaction, {
        organizationId: connection.organizationId,
        provider: "github",
        connectionId: connection.id,
        resourceId: null,
        input: { ...input, dropReason: GITHUB_LIFECYCLE },
      });
      if (!receipt.inserted) {
        return { status: "duplicate", providerEventReceiptId: receipt.id };
      }
      return {
        status: "claimed",
        providerEventReceiptId: receipt.id,
        installationId: input.installationId,
      };
    });
  }

  applyGitHubLifecycle(
    claim: Extract<GitHubLifecycleReceiptClaim, { status: "claimed" }>,
    result: GitHubLifecycleResult,
  ): Promise<void> {
    return this.database.transaction(async (transaction) => {
      const [evidence] = await transaction
        .select({ id: schema.providerEventReceipts.id })
        .from(schema.providerEventReceipts)
        .where(
          and(
            eq(schema.providerEventReceipts.id, claim.providerEventReceiptId),
            eq(schema.providerEventReceipts.droppedReason, GITHUB_LIFECYCLE),
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

  async releaseGitHubLifecycleReceipt(providerEventReceiptId: string): Promise<void> {
    await this.database
      .delete(schema.providerEventReceipts)
      .where(eq(schema.providerEventReceipts.id, providerEventReceiptId));
  }
}

async function findReceipt(
  transaction: HubTransaction,
  input: ProviderEventEvidence,
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

function selectFirstRoutePerProject<Route extends { projectId: string }>(
  routes: readonly Route[],
): Route[] {
  const selected = new Map<string, Route>();
  for (const route of routes) {
    if (!selected.has(route.projectId)) selected.set(route.projectId, route);
  }
  return [...selected.values()];
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

async function claimProviderReceipt(
  transaction: HubTransaction,
  input: {
    organizationId: string;
    provider: "github" | "slack" | "discord" | "manual";
    connectionId: string | null;
    resourceId: string | null;
    input: ProviderEventEvidence;
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
