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
  ProviderEventRouteSnapshot,
} from "./types.js";
import { routingDecisionSummary } from "../triggers/routing-evidence.js";

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
      if (existing !== undefined) {
        return replayProviderReceipt(transaction, existing, input.payload);
      }

      const dropReason =
        input.dropReason ??
        (provider === "github" && "status" in connection && connection.status === "suspended"
          ? "github_suspended"
          : undefined);
      if (dropReason !== undefined) {
        const droppedReceipt = await claimProviderReceipt(transaction, {
          organizationId: connection.organizationId,
          provider,
          connectionId: connection.id,
          resourceId: resourceId === undefined ? null : String(resourceId),
          input: { ...input, dropReason },
        });
        if (!droppedReceipt.inserted) {
          const existingReceipt = await findReceipt(transaction, input, connection.organizationId);
          if (existingReceipt === undefined) throw new Error("provider receipt unavailable");
          return replayProviderReceipt(transaction, existingReceipt, input.payload);
        }
        await transaction.insert(schema.providerEventRoutingOutcomes).values({
          organizationId: connection.organizationId,
          providerEventReceiptId: droppedReceipt.id,
          status: "dropped",
          expectedProjectCount: 0,
          completedProjectCount: 0,
          routedProjectCount: 0,
          createdAt: input.receivedAt,
          finalizedAt: input.receivedAt,
        });
        return { status: "dropped", receiptId: droppedReceipt.id, reason: dropReason };
      }
      const receipt = await claimProviderReceipt(transaction, {
        organizationId: connection.organizationId,
        provider,
        connectionId: connection.id,
        resourceId: resourceId === undefined ? null : String(resourceId),
        input,
      });
      if (!receipt.inserted) {
        const existingReceipt = await findReceipt(transaction, input, connection.organizationId);
        if (existingReceipt === undefined) throw new Error("provider receipt unavailable");
        return replayProviderReceipt(transaction, existingReceipt, input.payload);
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
          .set({ droppedReason: reason, signatureHash: null, payload: null })
          .where(eq(schema.providerEventReceipts.id, receipt.id));
        await transaction.insert(schema.providerEventRoutingDecisions).values({
          organizationId: connection.organizationId,
          providerEventReceiptId: receipt.id,
          code: "no_project_route",
          summary: routingDecisionSummary("no_project_route"),
        });
        await transaction.insert(schema.providerEventRoutingOutcomes).values({
          organizationId: connection.organizationId,
          providerEventReceiptId: receipt.id,
          status: "dropped",
          expectedProjectCount: 0,
          completedProjectCount: 0,
          routedProjectCount: 0,
          createdAt: input.receivedAt,
          finalizedAt: input.receivedAt,
        });
        return { status: "dropped", receiptId: receipt.id, reason };
      }

      const acceptedRoutes: ProviderEventRouteSnapshot[] = selectedRoutes.map((route) => ({
        projectId: route.projectId,
        configurationRevisionId: route.revisionId,
        connectionId: route.connectionId,
        resourceId: route.resourceId,
      }));
      await transaction
        .update(schema.providerEventReceipts)
        .set({ acceptedRoutes })
        .where(eq(schema.providerEventReceipts.id, receipt.id));
      await transaction.insert(schema.providerEventRoutingOutcomes).values({
        organizationId: connection.organizationId,
        providerEventReceiptId: receipt.id,
        status: "pending",
        expectedProjectCount: acceptedRoutes.length,
        completedProjectCount: 0,
        routedProjectCount: 0,
        createdAt: input.receivedAt,
        finalizedAt: null,
      });

      return {
        status: "accepted",
        events: acceptedRoutes.map((route) => ({
          providerEventReceiptId: receipt.id,
          organizationId: connection.organizationId,
          projectId: route.projectId,
          configurationRevisionId: route.configurationRevisionId,
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
        return replayManualReceipt(transaction, existing, input);
      }
      const [project] = await transaction
        .select({ configurationRevisionId: schema.projects.activeConfigurationRevisionId })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, input.projectId),
            eq(schema.projects.organizationId, input.organizationId),
            eq(schema.projects.status, "active"),
          ),
        );
      if (project?.configurationRevisionId === null || project === undefined) {
        throw new Error("manual project configuration unavailable");
      }
      const route: ProviderEventRouteSnapshot = {
        projectId: input.projectId,
        configurationRevisionId: project.configurationRevisionId,
        connectionId: input.connectionId ?? null,
        resourceId: input.resourceId ?? null,
      };
      const receipt = await claimProviderReceipt(transaction, {
        organizationId: input.organizationId,
        provider: "manual",
        connectionId: null,
        resourceId: null,
        input,
      });
      if (!receipt.inserted) {
        const duplicate = await findReceipt(transaction, input, input.organizationId);
        if (duplicate === undefined) {
          return { status: "duplicate", providerEventReceiptId: receipt.id };
        }
        return replayManualReceipt(transaction, duplicate, input);
      }
      await transaction
        .update(schema.providerEventReceipts)
        .set({ acceptedRoutes: [route] })
        .where(eq(schema.providerEventReceipts.id, receipt.id));
      await transaction.insert(schema.providerEventRoutingOutcomes).values({
        organizationId: input.organizationId,
        providerEventReceiptId: receipt.id,
        status: "pending",
        expectedProjectCount: 1,
        completedProjectCount: 0,
        routedProjectCount: 0,
        createdAt: input.receivedAt,
        finalizedAt: null,
      });
      return {
        status: "accepted",
        event: {
          providerEventReceiptId: receipt.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          configurationRevisionId: route.configurationRevisionId,
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

function eventFromReceipt(
  receipt: typeof schema.providerEventReceipts.$inferSelect,
  route: ProviderEventRouteSnapshot,
  payload: unknown = receipt.payload,
): import("./types.js").DurableProviderEvent {
  return {
    providerEventReceiptId: receipt.id,
    organizationId: receipt.organizationId,
    projectId: route.projectId,
    configurationRevisionId: route.configurationRevisionId,
    deliveryId: receipt.deliveryId,
    source: receipt.source,
    payload,
    receivedAt: receipt.receivedAt,
    connectionId: route.connectionId,
    resourceId: route.resourceId,
  };
}

async function replayManualReceipt(
  transaction: HubTransaction,
  receipt: typeof schema.providerEventReceipts.$inferSelect,
  input: PersistManualEventInput,
): Promise<ManualEventPersistence> {
  const route = parseAcceptedRoutes(receipt.acceptedRoutes)?.[0];
  if (route === undefined) {
    return { status: "duplicate", providerEventReceiptId: receipt.id };
  }
  const [outcome] = await transaction
    .select({ status: schema.providerEventRoutingOutcomes.status })
    .from(schema.providerEventRoutingOutcomes)
    .where(eq(schema.providerEventRoutingOutcomes.providerEventReceiptId, receipt.id))
    .limit(1);
  if (outcome?.status === "dropped") {
    return { status: "duplicate", providerEventReceiptId: receipt.id };
  }
  const payload = receipt.payload ?? (outcome?.status === "pending" ? input.payload : undefined);
  if (payload === undefined) {
    return { status: "duplicate", providerEventReceiptId: receipt.id };
  }
  return { status: "accepted", event: eventFromReceipt(receipt, route, payload) };
}

async function findReceipt(
  transaction: HubTransaction,
  input: ProviderEventEvidence,
  organizationId: string,
) {
  const [receipt] = await transaction
    .select()
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

async function replayProviderReceipt(
  transaction: HubTransaction,
  receipt: typeof schema.providerEventReceipts.$inferSelect,
  fallbackPayload: unknown,
): Promise<ProviderEventAcceptance> {
  if (receipt.droppedReason !== null) {
    return { status: "dropped", receiptId: receipt.id, reason: receipt.droppedReason };
  }
  const [outcome] = await transaction
    .select({ status: schema.providerEventRoutingOutcomes.status })
    .from(schema.providerEventRoutingOutcomes)
    .where(eq(schema.providerEventRoutingOutcomes.providerEventReceiptId, receipt.id))
    .limit(1);
  if (outcome?.status === "dropped") return { status: "duplicate", receiptId: receipt.id };
  const routes = parseAcceptedRoutes(receipt.acceptedRoutes);
  const payload = receipt.payload ?? (outcome?.status === "pending" ? fallbackPayload : undefined);
  if (routes === null || payload === undefined) {
    return { status: "duplicate", receiptId: receipt.id };
  }
  return {
    status: "accepted",
    receiptId: receipt.id,
    events: routes.map((route) => ({
      providerEventReceiptId: receipt.id,
      organizationId: receipt.organizationId,
      projectId: route.projectId,
      configurationRevisionId: route.configurationRevisionId,
      deliveryId: receipt.deliveryId,
      source: receipt.source,
      payload,
      receivedAt: receipt.receivedAt,
      connectionId: route.connectionId,
      resourceId: route.resourceId,
    })),
  };
}

function parseAcceptedRoutes(value: unknown): ProviderEventRouteSnapshot[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error("invalid accepted provider routes");
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("invalid accepted provider route");
    const projectId = candidate["projectId"];
    const configurationRevisionId = candidate["configurationRevisionId"];
    const connectionId = candidate["connectionId"];
    const resourceId = candidate["resourceId"];
    if (
      typeof projectId !== "string" ||
      typeof configurationRevisionId !== "string" ||
      (connectionId !== null && typeof connectionId !== "string") ||
      (resourceId !== null && typeof resourceId !== "string")
    ) {
      throw new Error("invalid accepted provider route");
    }
    return { projectId, configurationRevisionId, connectionId, resourceId };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      signatureHash:
        input.input.dropReason === undefined ? (input.input.signatureHash ?? null) : null,
      source: input.input.source,
      repo: input.input.repo ?? null,
      payload: null,
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
