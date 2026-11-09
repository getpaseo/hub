import { browserProviders, connectionBrowserProviders } from "../providers/browser.js";
import type { ProviderConnectionStatus } from "../providers/connection-presentation.js";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { handleConnections } from "../server/runtime.js";
import { connectionProviderName, type ConnectionProvider } from "./result-contract.js";

export type { ConnectionProvider } from "./result-contract.js";

export interface ConnectionStatus {
  canManage: boolean;
  [key: string]: boolean | ProviderConnectionStatus;
}
export const connectionStatusSchema = z
  .object({ canManage: z.boolean() })
  .passthrough()
  .transform((value, context) => {
    const result: ConnectionStatus = { canManage: value.canManage };
    for (const module of connectionBrowserProviders) {
      try {
        result[module.id] = module.connection.parseStatus(value[module.id]);
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error;
        for (const issue of error.issues)
          context.addIssue({ ...issue, path: [module.id, ...issue.path] });
      }
    }
    return result;
  });
export function statusForProvider(
  snapshot: ConnectionStatus,
  provider: string,
): ProviderConnectionStatus {
  const status = snapshot[provider];
  if (status === undefined || typeof status === "boolean")
    throw new Error(`connection status unavailable: ${provider}`);
  return status;
}
const scopeSchema = z.object({
  organizationSlug: z.string().min(1),
  projectSlug: z.string().min(1).optional(),
});
const providerSchema = scopeSchema.extend({
  provider: z.string().refine((id) => browserProviders.some((module) => module.id === id)),
});
const disconnectSchema = providerSchema.extend({ connectionId: z.string().uuid() });
const startSchema = z.object({ url: z.string().url() });

export type ConnectionDisconnectResult = `${ConnectionProvider}_disconnected`;

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
      const response = await handleConnections(
        operationRequest("POST", "/connections/start", data),
        { provider: data.provider, action: "start" },
      );
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
      const response = await handleConnections(
        operationRequest("POST", "/connections/disconnect", data, data.connectionId),
        { provider: data.provider, action: "disconnect" },
      );
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
  const incoming = getRequest();
  const headers = new Headers(incoming.headers);
  headers.delete("content-length");
  const url = new URL(path, incoming.url);
  url.searchParams.set("organizationSlug", scope.organizationSlug);
  if (scope.projectSlug !== undefined) url.searchParams.set("projectSlug", scope.projectSlug);
  if (connectionId !== undefined) url.searchParams.set("connectionId", connectionId);
  return new Request(url, {
    method,
    headers,
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}
