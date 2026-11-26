import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { INTEGRATION_ID_PATTERN } from "../integrations/browser-registry.js";
import { handleConnectionAction, handleConnections } from "../server/runtime.js";
import { connectionOperationRequest } from "./operation-request.server.js";
import {
  connectionProviderName,
  type ConnectionProvider,
  type LegacyConnectionProvider,
} from "./result-contract.js";

export type { ConnectionProvider } from "./result-contract.js";

const githubStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({
    status: z.enum(["connected", "suspended"]),
  }),
]);
const discordStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({
    status: z.literal("connected"),
  }),
]);
const slackStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("requiresReauthorization") }),
  z.object({
    status: z.literal("connected"),
  }),
]);
const linearStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("requiresReauthorization") }),
  z.object({ status: z.literal("connected") }),
]);
const genericStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("suspended") }),
  z.object({ status: z.literal("requiresReauthorization") }),
  z.object({ status: z.literal("connected") }),
]);
export const connectionStatusSchema = z
  .object({
    canManage: z.boolean(),
    github: githubStatusSchema,
    discord: discordStatusSchema,
    slack: slackStatusSchema,
    linear: linearStatusSchema,
  })
  .catchall(genericStatusSchema);
const scopeSchema = z.object({
  organizationSlug: z.string().min(1),
  projectSlug: z.string().min(1).optional(),
});
const providerSchema = scopeSchema.extend({
  provider: z.string().regex(INTEGRATION_ID_PATTERN),
});
const disconnectSchema = providerSchema.extend({ connectionId: z.string().uuid() });
const startSchema = z.object({ url: z.string().url() });

export type GenericProviderConnectionStatus = z.infer<typeof genericStatusSchema>;
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type ConnectionDisconnectResult = `${string}_disconnected`;

export function connectionStatusFor(
  status: ConnectionStatus,
  provider: ConnectionProvider,
): GenericProviderConnectionStatus {
  const value: unknown = Reflect.get(status, provider);
  const parsed = genericStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : { status: "notConfigured" };
}

export const connectionStatus = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<Result<ConnectionStatus>> => {
    try {
      const response = await handleConnections(
        operationRequest("GET", "/connections", data),
        "status",
      );
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.status",
          response,
          "Hub couldn't load this organization's connections. Reload the page.",
          data,
        );
      }
      return respondOk(connectionStatusSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.status", data), {
        fallback: "Hub couldn't load this organization's connections. Reload the page.",
      });
    }
  });

export const startConnection = createServerFn({ method: "POST" })
  .validator(providerSchema)
  .handler(async ({ data }): Promise<Result<{ url: string }>> => {
    const name = connectionProviderName(data.provider);
    try {
      const request = operationRequest("POST", "/connections/start", data);
      const response = isLegacyProvider(data.provider)
        ? await handleConnections(request, CONNECTION_OPERATIONS[data.provider].start)
        : await handleConnectionAction(request, data.provider, "start");
      if (response.status === 403) {
        return connectionResponseFailure(
          "connection.start",
          response,
          `You don't have permission to start ${name}.`,
          data,
        );
      }
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.start",
          response,
          `Hub couldn't start the ${name} connection. Check the app status and provider availability before starting again.`,
          data,
        );
      }
      return respondOk(startSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.start", data), {
        fallback: `Hub couldn't start the ${name} connection. Check the app status and provider availability before starting again.`,
      });
    }
  });

export const disconnectConnection = createServerFn({ method: "POST" })
  .validator(disconnectSchema)
  .handler(async ({ data }): Promise<Result<{ result: ConnectionDisconnectResult }>> => {
    const name = connectionProviderName(data.provider);
    try {
      const request = operationRequest("POST", "/connections/disconnect", data, data.connectionId);
      const response = isLegacyProvider(data.provider)
        ? await handleConnections(request, CONNECTION_OPERATIONS[data.provider].disconnect)
        : await handleConnectionAction(request, data.provider, "disconnect");
      if (response.status === 403) {
        return connectionResponseFailure(
          "connection.disconnect",
          response,
          `You don't have permission to disconnect ${name}.`,
          data,
        );
      }
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.disconnect",
          response,
          `Hub couldn't disconnect ${name}. Reload its connection status before disconnecting again.`,
          data,
        );
      }
      return respondOk({ result: `${data.provider}_disconnected` as const });
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.disconnect", data), {
        fallback: `Hub couldn't disconnect ${name}. Reload its connection status before disconnecting again.`,
      });
    }
  });

function isLegacyProvider(provider: string): provider is LegacyConnectionProvider {
  return (
    provider === "github" || provider === "discord" || provider === "slack" || provider === "linear"
  );
}

const CONNECTION_OPERATIONS = {
  github: { start: "githubStart", disconnect: "githubDisconnect" },
  discord: { start: "discordStart", disconnect: "discordDisconnect" },
  slack: { start: "slackStart", disconnect: "slackDisconnect" },
  linear: { start: "linearStart", disconnect: "linearDisconnect" },
} as const;

function connectionContext(
  operation: string,
  data: {
    organizationSlug: string;
    projectSlug?: string | undefined;
    provider?: ConnectionProvider | undefined;
  },
) {
  return {
    operation,
    component: "connections",
    organizationSlug: data.organizationSlug,
    ...(data.projectSlug === undefined ? {} : { projectSlug: data.projectSlug }),
    ...(data.provider === undefined ? {} : { provider: data.provider }),
  } as const;
}

function connectionResponseFailure(
  operation: string,
  response: Response,
  message: string,
  data: {
    organizationSlug: string;
    projectSlug?: string | undefined;
    provider?: ConnectionProvider | undefined;
  },
) {
  return respondWithFailure(
    new Error(`connection operation returned HTTP ${response.status}`),
    { ...connectionContext(operation, data), status: response.status },
    {
      fallback: message,
      authentication: message,
      forbidden: message,
      notFound: message,
      conflict: message,
      validation: message,
    },
    { status: response.status },
  );
}

function operationRequest(
  method: "GET" | "POST",
  path: string,
  scope: { organizationSlug: string; projectSlug?: string | undefined },
  connectionId?: string,
): Request {
  return connectionOperationRequest(method, path, {
    organizationSlug: scope.organizationSlug,
    ...(scope.projectSlug === undefined ? {} : { projectSlug: scope.projectSlug }),
    ...(connectionId === undefined ? {} : { connectionId }),
  });
}
