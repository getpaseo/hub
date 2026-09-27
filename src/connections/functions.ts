import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { handleConnections } from "../server/runtime.js";
import { connectionContext, connectionResponseFailure } from "./connection-failure.js";
import { forgejoOperationFailure, readForgejoErrorCode } from "./forgejo-failure.js";
import {
  CONNECTION_PROVIDERS,
  connectionProviderName,
  type ConnectionProvider,
} from "./result-contract.js";

export type { ConnectionProvider } from "./result-contract.js";

type ConnectionOperationName = Parameters<typeof handleConnections>[1];

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
/** No reauthorization arm: a pasted token does not expire, it is replaced. */
const forgejoStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("connected") }),
]);
export const connectionStatusSchema = z.object({
  canManage: z.boolean(),
  github: githubStatusSchema,
  discord: discordStatusSchema,
  slack: slackStatusSchema,
  linear: linearStatusSchema,
  forgejo: forgejoStatusSchema,
});
const scopeSchema = z.object({
  organizationSlug: z.string().min(1),
  projectSlug: z.string().min(1).optional(),
});
const providerSchema = scopeSchema.extend({
  provider: z.enum(CONNECTION_PROVIDERS),
});
const disconnectSchema = providerSchema.extend({
  connectionId: z.string().uuid(),
});
const startSchema = z.object({ url: z.string().url() });

// forgejo connects by pasting a token, not a redirect, so exclude it here too and let the
// validator reject it up front instead of a /connections/start request that fails anyway
const REDIRECT_START_PROVIDERS = ["github", "discord", "slack", "linear"] as const;
const startProviderSchema = scopeSchema.extend({
  provider: z.enum(REDIRECT_START_PROVIDERS),
});

export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
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
  .validator(startProviderSchema)
  .handler(async ({ data }): Promise<Result<{ url: string }>> => {
    const name = connectionProviderName(data.provider);
    try {
      const operation = REDIRECT_START_OPERATIONS[data.provider];
      const response = await handleConnections(
        operationRequest("POST", "/connections/start", data),
        operation,
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

const forgejoCreateSchema = scopeSchema.extend({
  instanceBaseUrl: z.string().min(1),
  accessToken: z.string().min(1),
});
const forgejoConnectionSchema = z.object({
  connection: z.object({
    id: z.string(),
    slug: z.string(),
    instanceBaseUrl: z.string(),
    accountLogin: z.string(),
    /** Shown once, so the operator can paste it into the instance's webhook form. */
    webhookSecret: z.string(),
    webhookUrl: z.string(),
  }),
});
export type ForgejoCreatedConnection = z.infer<typeof forgejoConnectionSchema>["connection"];

const BLOCKED_INSTANCE_MESSAGE =
  "Hub refuses to reach that address: it looks private, internal, or link-local, and this Hub isn't set up to allow it. Ask your operator to add it to FORGEJO_ALLOWED_PRIVATE_HOSTS, or use a public address.";
const REDIRECTED_INSTANCE_MESSAGE =
  "That address redirected somewhere else (often http to https), and Hub doesn't follow redirects when connecting an instance. Enter the address it redirected to and try again.";
const INSUFFICIENT_SCOPES_MESSAGE =
  "That token can't read its own account. Forgejo's read:user scope is missing; generate a token with it and try again.";
const ACCOUNT_ALREADY_CONNECTED_MESSAGE =
  "This account is already connected in this organization. Replace the token on the existing connection instead of adding a new one.";
const TOKEN_ACCOUNT_MISMATCH_MESSAGE =
  "That token belongs to a different account than this connection. Paste a token for the same account, or disconnect and reconnect to switch accounts.";
const UNSUPPORTED_FLAVOR_MESSAGE =
  "Hub couldn't tell this is a Forgejo or Gitea instance from its version response. Gogs is not supported.";

export const createForgejoConnection = createServerFn({ method: "POST" })
  .validator(forgejoCreateSchema)
  .handler(async ({ data }): Promise<Result<ForgejoCreatedConnection>> => {
    const scope = {
      organizationSlug: data.organizationSlug,
      projectSlug: data.projectSlug,
    };
    const report = { ...scope, provider: "forgejo" as const };
    try {
      const response = await handleConnections(
        operationRequest("POST", "/connections/start", scope, undefined, {
          instanceBaseUrl: data.instanceBaseUrl,
          accessToken: data.accessToken,
        }),
        "forgejoCreate",
      );
      if (!response.ok) {
        return await forgejoOperationFailure("create", response, report, {
          permissionMessage: "You don't have permission to connect Forgejo.",
          fallbackMessage:
            "Hub couldn't reach that instance with that token. Check the address and the token, then try again.",
          cases: [
            {
              status: 400,
              resolve: async (r) => {
                const code = await readForgejoErrorCode(r);
                if (code === "instance_address_blocked") return BLOCKED_INSTANCE_MESSAGE;
                if (code === "instance_redirected") return REDIRECTED_INSTANCE_MESSAGE;
                if (code === "instance_unsupported_flavor") return UNSUPPORTED_FLAVOR_MESSAGE;
                return undefined;
              },
            },
            {
              status: 422,
              resolve: async (r) => {
                const code = await readForgejoErrorCode(r);
                return code === "insufficient_token_scopes"
                  ? INSUFFICIENT_SCOPES_MESSAGE
                  : undefined;
              },
            },
            {
              status: 409,
              resolve: async (r) => {
                const code = await readForgejoErrorCode(r);
                return code === "account_already_connected"
                  ? ACCOUNT_ALREADY_CONNECTED_MESSAGE
                  : undefined;
              },
            },
          ],
        });
      }
      return respondOk(forgejoConnectionSchema.parse(await response.json()).connection);
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.create", report), {
        fallback:
          "Hub couldn't connect that Forgejo instance. Check the address and the token, then try again.",
      });
    }
  });

export const disconnectConnection = createServerFn({ method: "POST" })
  .validator(disconnectSchema)
  .handler(async ({ data }): Promise<Result<{ result: ConnectionDisconnectResult }>> => {
    const name = connectionProviderName(data.provider);
    try {
      const operation = DISCONNECT_OPERATIONS[data.provider];
      const response = await handleConnections(
        operationRequest("POST", "/connections/disconnect", data, data.connectionId),
        operation,
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

const forgejoTargetSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("user") }),
  z.object({ scope: z.literal("org"), org: z.string().min(1) }),
]);
export type ForgejoSubscribeTarget = z.infer<typeof forgejoTargetSchema>;

const forgejoOrgsSchema = scopeSchema.extend({
  connectionId: z.string().uuid(),
});
const forgejoOrgsResponseSchema = z.object({
  orgs: z.array(z.object({ username: z.string() })),
  /** true when the instance refused the listing; only the org picker degrades */
  unavailable: z.boolean(),
  webhookUrl: z.string(),
  webhookSecret: z.string(),
});
export type ForgejoOrgs = z.infer<typeof forgejoOrgsResponseSchema>;

export const listForgejoOrgs = createServerFn({ method: "POST" })
  .validator(forgejoOrgsSchema)
  .handler(async ({ data }): Promise<Result<ForgejoOrgs>> => {
    const scope = {
      organizationSlug: data.organizationSlug,
      projectSlug: data.projectSlug,
    };
    const report = { ...scope, provider: "forgejo" as const };
    try {
      const response = await handleConnections(
        operationRequest("POST", "/connections/orgs", scope, data.connectionId),
        "forgejoOrgs",
      );
      if (!response.ok) {
        return await forgejoOperationFailure("orgs", response, report, {
          permissionMessage: "You don't have permission to manage this connection.",
          fallbackMessage: "Hub couldn't list organizations on that instance.",
        });
      }
      return respondOk(forgejoOrgsResponseSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.orgs", report), {
        fallback: "Hub couldn't list organizations on that instance.",
      });
    }
  });

const forgejoSubscribeSchema = scopeSchema.extend({
  connectionId: z.string().uuid(),
  target: forgejoTargetSchema,
});
const forgejoSubscribeResponseSchema = z.object({
  scope: z.enum(["user", "org"]),
  owner: z.string(),
  webhookUrl: z.string(),
});
export type ForgejoSubscribed = z.infer<typeof forgejoSubscribeResponseSchema>;

const HOOK_PERMISSION_MESSAGE =
  "Forgejo refused to create the webhook. The token needs write access to your account (or, for an organization, to that organization), and an organization hook also needs you to own it.";
const ORG_NOT_FOUND_MESSAGE =
  "Hub couldn't find that organization on the instance, or this token can't see it. Check the name and try again.";
const OPERATION_IN_PROGRESS_MESSAGE =
  "Another change to this connection is still running. Try again in a moment.";

const forgejoHookErrorBodySchema = z.object({
  error: z.string(),
  /** Present only for `hook_rejected`: the instance's own reason (e.g. "Invalid url"). */
  reason: z.string().optional(),
});

function hookRejectedMessage(reason: string | undefined): string {
  return reason === undefined
    ? "Forgejo rejected the webhook."
    : `Forgejo rejected the webhook: ${reason}`;
}

// retrying is safe: subscribing again for the same target replaces the existing hook
// instead of creating a second one, see hooks.ts's createSubscribedHook
export const subscribeForgejoWebhook = createServerFn({ method: "POST" })
  .validator(forgejoSubscribeSchema)
  .handler(async ({ data }): Promise<Result<ForgejoSubscribed>> => {
    const scope = {
      organizationSlug: data.organizationSlug,
      projectSlug: data.projectSlug,
    };
    const report = { ...scope, provider: "forgejo" as const };
    try {
      const response = await handleConnections(
        operationRequest("POST", "/connections/subscribe", scope, data.connectionId, data.target),
        "forgejoSubscribe",
      );
      if (!response.ok) {
        return await forgejoOperationFailure("subscribe", response, report, {
          permissionMessage: "You don't have permission to manage this connection.",
          fallbackMessage: "Hub couldn't set up the webhook on that instance.",
          cases: [
            // permission denied and hook rejected both answer 422; tell them apart by
            // the body's error code, see hooks.ts's hookPermissionResponse
            {
              status: 422,
              resolve: async (r) => {
                const body = forgejoHookErrorBodySchema.safeParse(
                  await r.json().catch(() => undefined),
                );
                if (!body.success) return undefined;
                if (body.data.error === "hook_permission_denied") return HOOK_PERMISSION_MESSAGE;
                if (body.data.error === "hook_rejected")
                  return hookRejectedMessage(body.data.reason);
                return undefined;
              },
            },
            {
              status: 404,
              resolve: async (r) => {
                const code = await readForgejoErrorCode(r);
                return code === "hook_target_not_found" ? ORG_NOT_FOUND_MESSAGE : undefined;
              },
            },
            // a concurrent subscribe or disconnect already holds the hook lease, see withForgejoHookLease
            { status: 409, resolve: () => OPERATION_IN_PROGRESS_MESSAGE },
          ],
        });
      }
      return respondOk(forgejoSubscribeResponseSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.subscribe", report), {
        fallback: "Hub couldn't set up the webhook on that instance.",
      });
    }
  });

const forgejoReplaceTokenSchema = scopeSchema.extend({
  connectionId: z.string().uuid(),
  accessToken: z.string().min(1),
});
const forgejoReplaceTokenResponseSchema = z.object({ replaced: z.boolean() });

export const replaceForgejoConnectionToken = createServerFn({ method: "POST" })
  .validator(forgejoReplaceTokenSchema)
  .handler(async ({ data }): Promise<Result<{ replaced: boolean }>> => {
    const scope = {
      organizationSlug: data.organizationSlug,
      projectSlug: data.projectSlug,
    };
    const report = { ...scope, provider: "forgejo" as const };
    try {
      const response = await handleConnections(
        operationRequest("POST", "/connections/replace-token", scope, data.connectionId, {
          accessToken: data.accessToken,
        }),
        "forgejoReplaceToken",
      );
      if (!response.ok) {
        return await forgejoOperationFailure("replaceToken", response, report, {
          permissionMessage: "You don't have permission to manage this connection.",
          fallbackMessage:
            "Hub couldn't reach that instance with that token. Check the token and try again.",
          cases: [
            {
              status: 400,
              resolve: async (r) => {
                const code = await readForgejoErrorCode(r);
                if (code === "instance_address_blocked") return BLOCKED_INSTANCE_MESSAGE;
                if (code === "instance_redirected") return REDIRECTED_INSTANCE_MESSAGE;
                if (code === "instance_unsupported_flavor") return UNSUPPORTED_FLAVOR_MESSAGE;
                return undefined;
              },
            },
            {
              status: 422,
              resolve: async (r) => {
                const code = await readForgejoErrorCode(r);
                if (code === "insufficient_token_scopes") return INSUFFICIENT_SCOPES_MESSAGE;
                if (code === "token_account_mismatch") return TOKEN_ACCOUNT_MISMATCH_MESSAGE;
                return undefined;
              },
            },
          ],
        });
      }
      return respondOk(forgejoReplaceTokenResponseSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.replaceToken", report), {
        fallback: "Hub couldn't replace that connection's token. Check it and try again.",
      });
    }
  });

const REDIRECT_START_OPERATIONS: Record<
  (typeof REDIRECT_START_PROVIDERS)[number],
  ConnectionOperationName
> = {
  github: "githubStart",
  discord: "discordStart",
  slack: "slackStart",
  linear: "linearStart",
};

const DISCONNECT_OPERATIONS: Record<ConnectionProvider, ConnectionOperationName> = {
  github: "githubDisconnect",
  discord: "discordDisconnect",
  slack: "slackDisconnect",
  linear: "linearDisconnect",
  forgejo: "forgejoDisconnect",
};

function operationRequest(
  method: "GET" | "POST",
  path: string,
  scope: { organizationSlug: string; projectSlug?: string | undefined },
  connectionId?: string,
  payload?: unknown,
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
    ...(method === "POST" ? { body: JSON.stringify(payload ?? {}) } : {}),
  });
}
