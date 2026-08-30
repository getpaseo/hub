import type { AuthServer } from "../../auth/server.js";
import type { ForgejoConfigurationProvider } from "../../configuration/forgejo-sync.js";
import type { Database, OrganizationConnectionUsage } from "../../db/types.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";

export const FORGEJO_REQUEST_NAMES = [
  "forgejo.instances",
  "forgejo.connections",
  "forgejo.webhook",
] as const;

export const FORGEJO_IDENTITY = {
  provider: "forgejo",
  id: "forgejo",
  name: "Forgejo",
} as const;

export interface CreateForgejoRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  publicBaseUrl?: string;
  configuration?: { provider: "forgejo" } | null;
  configurationProvider?: ForgejoConfigurationProvider;
}

export function createForgejoRegistration(
  options: CreateForgejoRegistrationOptions,
): ProviderRegistration {
  const configured = options.configuration !== null && options.configuration !== undefined;
  return {
    connection: forgejoConnectionStatus(configured),
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests: FORGEJO_REQUEST_NAMES.map((name) => ({
      name,
      handle: () => Promise.resolve(Response.json({ error: "unavailable" }, { status: 409 })),
    })),
    ...(options.configurationProvider === undefined
      ? {}
      : { forgejoConfiguration: options.configurationProvider }),
  };
}

function forgejoConnectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "forgejo",
    status: (connections: OrganizationConnectionUsage) =>
      forgejoStatus(configured, connections.forgejo),
    actions: {
      start: () => Promise.resolve(Response.json({ error: "unavailable" }, { status: 409 })),
      disconnect: () => Promise.resolve(Response.json({ error: "unavailable" }, { status: 409 })),
    },
  };
}

function forgejoStatus(
  configured: boolean,
  connections: OrganizationConnectionUsage["forgejo"],
): { status: "notConfigured" | "configured"; connections: typeof connections } {
  return {
    status: configured ? "configured" : "notConfigured",
    connections,
  };
}
