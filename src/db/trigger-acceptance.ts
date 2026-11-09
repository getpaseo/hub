import { and, eq, isNull, or } from "drizzle-orm";
import type { DatabaseRuntime, DrizzleHandle } from "./runtime/index.js";
import type { Locks } from "./runtime/locks/index.js";
import * as schema from "./schema.js";

import type {
  ConnectionProvider,
  ManualEventPersistence,
  PersistManualEventInput,
  ProviderEventAcceptance,
  ProviderEventEvidence,
  ProviderEventRouteSnapshot,
} from "./types.js";

type HubDatabase = DrizzleHandle;
type HubTransaction = DrizzleHandle;

export class ProviderEventAcceptanceRepository {
  private readonly database: HubDatabase;
  constructor(
    private readonly runtime: DatabaseRuntime,
    private readonly locks: Locks,
  ) {
    this.database = runtime.drizzle();
  }

  async acceptProvider(
    provider: ConnectionProvider,
    resourceId: number | string | undefined,
    input: ProviderEventEvidence,
    resolveConnection: (
      transaction: DrizzleHandle,
    ) => Promise<{ id: string; organizationId: string; unavailable: boolean } | undefined>,
  ): Promise<ProviderEventAcceptance> {
    return this.database.transaction(async (transaction) => {
      const connection = await resolveConnection(transaction);
      if (connection === undefined) {
        return { status: "dropped", receiptId: input.deliveryId, reason: `${provider}_unbound` };
      }

      const existing = await findReceipt(transaction, input, connection.organizationId);
      if (existing !== undefined) return replayProviderReceipt(existing);

      const dropReason =
        input.dropReason ?? (connection.unavailable ? "configuration_unavailable" : undefined);
      const receipt = await claimProviderReceipt(transaction, {
        organizationId: connection.organizationId,
        provider,
        connectionId: connection.id,
        resourceId: resourceId === undefined ? null : String(resourceId),
        input: dropReason === undefined ? input : { ...input, dropReason },
      });
      if (!receipt.inserted) {
        const existingReceipt = await findReceipt(transaction, input, connection.organizationId);
        if (existingReceipt === undefined) throw new Error("provider receipt unavailable");
        return replayProviderReceipt(existingReceipt);
      }
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
        const reason = "no_project_route";
        await transaction
          .update(schema.providerEventReceipts)
          .set({ droppedReason: reason })
          .where(eq(schema.providerEventReceipts.id, receipt.id));
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
        const route = parseAcceptedRoutes(existing.acceptedRoutes)?.[0];
        if (route === undefined) {
          return { status: "duplicate", providerEventReceiptId: existing.id };
        }
        return {
          status: "accepted",
          event: eventFromReceipt(existing, route),
        };
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
        const duplicateRoute = parseAcceptedRoutes(duplicate?.acceptedRoutes)?.[0];
        if (duplicate === undefined || duplicateRoute === undefined) {
          return { status: "duplicate", providerEventReceiptId: receipt.id };
        }
        return { status: "accepted", event: eventFromReceipt(duplicate, duplicateRoute) };
      }
      await transaction
        .update(schema.providerEventReceipts)
        .set({ acceptedRoutes: [route] })
        .where(eq(schema.providerEventReceipts.id, receipt.id));
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
}

function eventFromReceipt(
  receipt: typeof schema.providerEventReceipts.$inferSelect,
  route: ProviderEventRouteSnapshot,
): import("./types.js").DurableProviderEvent {
  return {
    providerEventReceiptId: receipt.id,
    organizationId: receipt.organizationId,
    projectId: route.projectId,
    configurationRevisionId: route.configurationRevisionId,
    deliveryId: receipt.deliveryId,
    source: receipt.source,
    payload: receipt.payload,
    receivedAt: receipt.receivedAt,
    connectionId: route.connectionId,
    resourceId: route.resourceId,
  };
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

function replayProviderReceipt(
  receipt: typeof schema.providerEventReceipts.$inferSelect,
): ProviderEventAcceptance {
  if (receipt.droppedReason !== null) {
    return { status: "dropped", receiptId: receipt.id, reason: receipt.droppedReason };
  }
  const routes = parseAcceptedRoutes(receipt.acceptedRoutes);
  if (routes === null) return { status: "duplicate", receiptId: receipt.id };
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
      payload: receipt.payload,
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

export async function claimProviderReceipt(
  transaction: HubTransaction,
  input: {
    organizationId: string;
    provider: string;
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
      providerApplicationId: input.input.providerApplicationId ?? null,
      providerConfigurationVersion: input.input.providerConfigurationVersion ?? null,
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
