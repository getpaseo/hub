import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
import { handleConnections } from "../server/runtime.js";

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
export const connectionStatusSchema = z.object({
  canManage: z.boolean(),
  github: githubStatusSchema,
  discord: discordStatusSchema,
  slack: slackStatusSchema,
});
const scopeSchema = z.object({
  organizationSlug: z.string().min(1),
  projectSlug: z.string().min(1).optional(),
});
const providerSchema = scopeSchema.extend({ provider: z.enum(["github", "discord", "slack"]) });
const disconnectSchema = providerSchema.extend({ connectionId: z.string().uuid() });
const startSchema = z.object({ url: z.string().url() });

export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type ConnectionProvider = z.infer<typeof providerSchema>["provider"];
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
        return respondError({ message: "We couldn't load this organization's connections." });
      }
      return respondOk(connectionStatusSchema.parse(await response.json()));
    } catch {
      return respondError({ message: "We couldn't load this organization's connections." });
    }
  });

export const startConnection = createServerFn({ method: "POST" })
  .validator(providerSchema)
  .handler(async ({ data }): Promise<Result<{ url: string }>> => {
    const name = providerName(data.provider);
    try {
      const operation = CONNECTION_OPERATIONS[data.provider].start;
      const response = await handleConnections(
        operationRequest("POST", "/connections/start", data),
        operation,
      );
      if (response.status === 403) {
        return respondError({ message: `You don't have permission to start ${name}.` });
      }
      if (!response.ok) {
        return respondError({ message: `We couldn't start the ${name} connection. Try again.` });
      }
      return respondOk(startSchema.parse(await response.json()));
    } catch {
      return respondError({ message: `We couldn't start the ${name} connection. Try again.` });
    }
  });

export const disconnectConnection = createServerFn({ method: "POST" })
  .validator(disconnectSchema)
  .handler(async ({ data }): Promise<Result<{ result: ConnectionDisconnectResult }>> => {
    const name = providerName(data.provider);
    try {
      const operation = CONNECTION_OPERATIONS[data.provider].disconnect;
      const response = await handleConnections(
        operationRequest("POST", "/connections/disconnect", data, data.connectionId),
        operation,
      );
      if (response.status === 403) {
        return respondError({ message: `You don't have permission to disconnect ${name}.` });
      }
      if (!response.ok) {
        return respondError({ message: `We couldn't disconnect ${name}. Try again.` });
      }
      return respondOk({ result: `${data.provider}_disconnected` as const });
    } catch {
      return respondError({ message: `We couldn't disconnect ${name}. Try again.` });
    }
  });

const CONNECTION_OPERATIONS = {
  github: { start: "githubStart", disconnect: "githubDisconnect" },
  discord: { start: "discordStart", disconnect: "discordDisconnect" },
  slack: { start: "slackStart", disconnect: "slackDisconnect" },
} as const;

function providerName(provider: ConnectionProvider): string {
  if (provider === "github") return "GitHub";
  return provider === "discord" ? "Discord" : "Slack";
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
