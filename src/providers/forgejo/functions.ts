import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../../contract/respond.js";
import { ALLOWED_CONNECTION_SCOPES } from "./connections.js";
import { handleProviderRequest } from "../../server/runtime.js";
import { FORGEJO_PAT_MASK } from "./instances.js";

const instanceSchema = z.object({
  id: z.string(),
  canonicalOrigin: z.string(),
  reportedVersion: z.string(),
  status: z.enum([
    "pending_verification",
    "active",
    "incompatible",
    "unreachable",
    "identity_drifted",
    "revoked",
  ]),
  lastHealthError: z.string().nullable().optional(),
});

const repositorySchema = z.object({
  repositoryId: z.number(),
  fullName: z.string(),
  htmlUrl: z.string(),
  enrolled: z.boolean(),
});

const connectionSchema = z.object({
  id: z.string(),
  slug: z.string(),
  instanceId: z.string(),
  forgejoUserLogin: z.string(),
  status: z.enum(["pending_identity", "active", "degraded", "disconnected"]),
  credential: z.object({ kind: z.literal("connection"), secret: z.literal(FORGEJO_PAT_MASK) }),
  repositories: z.array(repositorySchema),
});

export interface ForgejoInstanceList {
  instances: z.infer<typeof instanceSchema>[];
}
export interface ForgejoConnectionList {
  approvedInstances: z.infer<typeof instanceSchema>[];
  connections: z.infer<typeof connectionSchema>[];
}

export const listForgejoInstances = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ForgejoInstanceList>> => readInstanceList(),
);

export const approveForgejoInstance = createServerFn({ method: "POST" })
  .validator(
    z
      .object({
        origin: z.string().min(1),
        allowPrivateNetwork: z.boolean(),
      })
      .strict(),
  )
  .handler(async ({ data }): Promise<Result<ForgejoInstanceList>> => {
    const response = await handleProviderRequest(
      "forgejo.instances",
      forgejoApiRequest("/instances", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    );
    if (!response.ok) return forgejoFailure(response);
    return readInstanceList();
  });

export const listForgejoConnections = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ForgejoConnectionList>> => readConnectionList(),
);

export const createForgejoConnection = createServerFn({ method: "POST" })
  .validator(
    z
      .object({
        instanceId: z.string().min(1),
        slug: z.string().min(1),
        claimedUsername: z.string().min(1),
        pat: z.string().min(1),
      })
      .strict(),
  )
  .handler(async ({ data }): Promise<Result<ForgejoConnectionList>> => {
    const response = await handleProviderRequest(
      "forgejo.connections",
      forgejoApiRequest("/connections", {
        method: "POST",
        body: JSON.stringify({
          ...data,
          scopes: [...ALLOWED_CONNECTION_SCOPES],
        }),
      }),
    );
    if (!response.ok) return forgejoFailure(response);
    return readConnectionList();
  });

export const enrollForgejoRepositories = createServerFn({ method: "POST" })
  .validator(
    z
      .object({
        connectionId: z.string().min(1),
        repositoryIds: z.array(z.number().int()),
      })
      .strict(),
  )
  .handler(async ({ data }): Promise<Result<ForgejoConnectionList>> => {
    const response = await handleProviderRequest(
      "forgejo.connections",
      forgejoApiRequest(`/connections/${data.connectionId}/enroll`, {
        method: "POST",
        body: JSON.stringify({ repositoryIds: data.repositoryIds }),
      }),
    );
    if (!response.ok) return forgejoFailure(response);
    return readConnectionList();
  });

const hookStatusSchema = z.enum([
  "unconfigured",
  "pending_verification",
  "active",
  "manual_pending",
  "drifted",
  "cleanup_failed",
]);

const hookViewSchema = z.object({
  repositoryId: z.number(),
  fullName: z.string(),
  htmlUrl: z.string(),
  managed: z.boolean(),
  status: hookStatusSchema,
});

const hookSetupSchema = z.object({
  connectionId: z.string(),
  callbackUrl: z.string(),
  events: z.array(z.string()),
  credential: z.object({ kind: z.literal("webhook_secret"), secret: z.string() }),
  hooks: z.array(hookViewSchema),
});

export type ForgejoHookSetup = z.infer<typeof hookSetupSchema>;

export const listForgejoHooks = createServerFn({ method: "GET" })
  .validator(z.object({ connectionId: z.string().min(1) }).strict())
  .handler(async ({ data }): Promise<Result<ForgejoHookSetup>> => {
    return forgejoResult(
      await handleProviderRequest(
        "forgejo.webhook",
        forgejoApiRequest(`/connections/${data.connectionId}/hooks`),
      ),
      (body) => hookSetupSchema.parse(body),
    );
  });

export const setupForgejoHooks = createServerFn({ method: "POST" })
  .validator(
    z.discriminatedUnion("mode", [
      z.object({ connectionId: z.string().min(1), mode: z.literal("manual") }).strict(),
      z
        .object({
          connectionId: z.string().min(1),
          mode: z.literal("automatic"),
          adminPat: z.string().min(1),
        })
        .strict(),
    ]),
  )
  .handler(async ({ data }): Promise<Result<ForgejoHookSetup>> => {
    const body =
      data.mode === "automatic"
        ? { mode: "automatic", adminPat: data.adminPat }
        : { mode: "manual" };
    return forgejoResult(
      await handleProviderRequest(
        "forgejo.webhook",
        forgejoApiRequest(`/connections/${data.connectionId}/hooks`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      ),
      (parsed) => hookSetupSchema.parse(parsed),
    );
  });

async function readInstanceList(): Promise<Result<ForgejoInstanceList>> {
  return forgejoResult(
    await handleProviderRequest("forgejo.instances", forgejoApiRequest("/instances")),
    (body) => ({ instances: z.array(instanceSchema).parse(body["instances"]) }),
  );
}

async function readConnectionList(): Promise<Result<ForgejoConnectionList>> {
  return forgejoResult(
    await handleProviderRequest("forgejo.connections", forgejoApiRequest("/connections")),
    (body) => ({
      approvedInstances: z.array(instanceSchema).parse(body["approvedInstances"]),
      connections: z.array(connectionSchema).parse(body["connections"]),
    }),
  );
}

function forgejoApiRequest(path: string, init: { method?: string; body?: string } = {}): Request {
  const incoming = getRequest();
  const url = new URL(`/api/integrations/forgejo${path}`, incoming.url);
  const headers = new Headers(incoming.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

async function forgejoResult<T>(
  response: Response,
  parse: (body: Record<string, unknown>) => T,
): Promise<Result<T>> {
  if (!response.ok) return forgejoFailure(response);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return respondError({ message: "Forgejo response is invalid" });
  }
  return respondOk(parse(Object.fromEntries(Object.entries(body))));
}

async function forgejoFailure(response: Response): Promise<Result<never>> {
  const body: unknown = await response.json().catch(() => undefined);
  const code =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : "forgejo_origin_unapproved";
  return respondError({ message: code });
}
