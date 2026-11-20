import { z } from "zod";
import type { Database, OrganizationConnectionUsage } from "../db/types.js";
import type { IntegrationProvider, IntegrationToolGrant } from "./grants.js";

export class IntegrationToolError extends Error {}

export class IntegrationHttpError extends IntegrationToolError {
  constructor(
    readonly status: number,
    readonly code?: number,
  ) {
    super(
      `The provider rejected the request (HTTP ${status}). Check the connection and bot permissions.`,
    );
  }
}

export interface IntegrationToolCall {
  name: string;
  organizationId: string;
  grant: IntegrationToolGrant;
  args: Record<string, unknown>;
}

export type IntegrationToolHandler = (call: IntegrationToolCall) => Promise<unknown>;

export async function ownedConnection<P extends IntegrationProvider>(
  database: Database,
  provider: P,
  appId: string,
  organizationId: string,
  slug: string,
): Promise<OrganizationConnectionUsage[P][number]> {
  const connections = await database.organizationConnectionUsage(organizationId);
  const connection = connections[provider].find(
    (candidate) =>
      candidate.organizationId === organizationId &&
      candidate.slug === slug &&
      candidate.providerApplicationId === appId,
  );
  if (connection === undefined)
    throw new IntegrationToolError(
      "The integration connection is unavailable in this organization.",
    );
  return connection;
}

export function requireChannel(grant: IntegrationToolGrant, id: string) {
  if (!grant.channels.includes(id))
    throw new IntegrationToolError("The channel or thread is outside this execution's grant.");
}

export function providerHttp(base: string, authorization: string, request: typeof fetch) {
  return async <T>(path: string, schema: z.ZodType<T>, body?: object): Promise<T> => {
    const response = await request(base + path, {
      headers: {
        authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12_000),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new IntegrationHttpError(response.status);
    }
    return schema.parse(await response.json());
  };
}
