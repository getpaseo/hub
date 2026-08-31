import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../../contract/respond.js";
import { ALLOWED_CONNECTION_SCOPES } from "./connections.js";
import { handleProviderRequest } from "../../server/runtime.js";
import { FORGEJO_PAT_MASK } from "./instances.js";

const healthViewSchema = z.object({
  workKind: z.string(),
  workIdentity: z.string().optional(),
  status: z.string(),
  typedCause: z.string().nullable(),
  attemptCount: z.number().optional(),
  lastSuccessAt: z.string().nullable().optional(),
  lastFailureAt: z.string().nullable().optional(),
  nextAttemptAt: z.string().nullable(),
  remediation: z.string(),
});

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
  health: z.array(healthViewSchema).optional(),
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

const hookStatusSchema = z.enum([
  "unconfigured",
  "pending_verification",
  "active",
  "manual_pending",
  "drifted",
  "cleanup_failed",
]);

const lifecycleRepositorySchema = z.object({
  repositoryId: z.number().int(),
  fullName: z.string(),
  enrolled: z.boolean(),
});

const lifecycleHookSchema = z.object({
  repositoryId: z.number().int(),
  fullName: z.string().nullable(),
  managed: z.boolean(),
  status: hookStatusSchema,
});

const lifecycleConfigurationSchema = z.object({
  projectId: z.string(),
  repositoryId: z.number().int(),
  activeRevisionId: z.string().nullable(),
});

const lifecycleRouteSchema = z.object({
  projectId: z.string(),
  repositoryId: z.number().int(),
  configurationRevisionId: z.string(),
});

const lifecycleWorkSchema = z.object({
  projectId: z.string(),
  configurationRevisionId: z.string(),
  triggerRunId: z.string(),
  stepRunId: z.string(),
});

const disconnectImpactSchema = z.object({
  connectionId: z.string(),
  repositories: z.array(lifecycleRepositorySchema),
  hooks: z.array(lifecycleHookSchema),
  configurationSources: z.array(lifecycleConfigurationSchema),
  activeRevisions: z.array(z.object({ projectId: z.string(), revisionId: z.string() })),
  triggerRoutes: z.array(lifecycleRouteSchema),
  hydrationSignals: z.array(
    z.object({ repositoryId: z.number().int(), effect: z.literal("future_hydration_disabled") }),
  ),
  work: z.object({
    queued: z.array(lifecycleWorkSchema),
    inFlight: z.array(lifecycleWorkSchema),
    queuedEffect: z.literal("revalidates_before_execution"),
    inFlightEffect: z.literal("already_minted_authority_is_not_recalled"),
  }),
  futureExecution: z.literal("blocked"),
});

export type ForgejoDisconnectImpact = z.infer<typeof disconnectImpactSchema>;

const disconnectCleanupSchema = z.object({
  repositoryId: z.number().int(),
  fullName: z.string().nullable(),
  managed: z.boolean(),
  result: z.enum(["removed", "preserved_manual", "pending"]),
});

const disconnectResultSchema = z.object({
  disconnected: z.literal(true),
  impact: disconnectImpactSchema,
  cleanupStatus: z.enum(["complete", "REMOTE_CLEANUP_PENDING"]),
  cleanup: z.array(disconnectCleanupSchema),
});

export type ForgejoDisconnectResult = z.infer<typeof disconnectResultSchema>;

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

export const probeForgejoInstanceHealth = createServerFn({ method: "POST" })
  .validator(z.object({ instanceId: z.string().min(1) }).strict())
  .handler(async ({ data }): Promise<Result<ForgejoInstanceList>> => {
    const response = await handleProviderRequest(
      "forgejo.instances",
      forgejoApiRequest(`/instances/${data.instanceId}/health`, { method: "POST" }),
    );
    if (!response.ok) return forgejoFailure(response);
    return readInstanceList();
  });

export const recoverForgejoRemoteCleanup = createServerFn({ method: "POST" })
  .validator(
    z
      .object({
        connectionId: z.string().min(1),
        webhookAdminPat: z.string().min(1),
      })
      .strict(),
  )
  .handler(async ({ data }): Promise<Result<ForgejoConnectionList>> => {
    const response = await handleProviderRequest(
      "forgejo.connections",
      forgejoApiRequest(`/connections/${data.connectionId}/recover-cleanup`, {
        method: "POST",
        body: JSON.stringify({ webhookAdminPat: data.webhookAdminPat }),
      }),
    );
    if (!response.ok) return forgejoFailure(response);
    return readConnectionList();
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

export const rotateForgejoConnectionCredential = createServerFn({ method: "POST" })
  .validator(
    z
      .object({
        connectionId: z.string().min(1),
        pat: z.string().min(1),
        scopes: z.array(z.string().min(1)).min(1),
        repositoryIds: z.array(z.number().int()).min(1),
      })
      .strict(),
  )
  .handler(async ({ data }): Promise<Result<ForgejoConnectionList>> => {
    const response = await handleProviderRequest(
      "forgejo.connections",
      forgejoApiRequest(`/connections/${data.connectionId}/credentials/connection/rotate`, {
        method: "POST",
        body: JSON.stringify({
          pat: data.pat,
          scopes: data.scopes,
          repositories: data.repositoryIds,
        }),
      }),
    );
    if (!response.ok) return forgejoFailure(response);
    return readConnectionList();
  });

export const revokeForgejoConnectionCredential = createServerFn({ method: "POST" })
  .validator(z.object({ connectionId: z.string().min(1) }).strict())
  .handler(async ({ data }): Promise<Result<ForgejoConnectionList>> => {
    const response = await handleProviderRequest(
      "forgejo.connections",
      forgejoApiRequest(`/connections/${data.connectionId}/credentials/connection/revoke`, {
        method: "POST",
        body: "{}",
      }),
    );
    if (!response.ok) return forgejoFailure(response);
    return readConnectionList();
  });

export const configureForgejoExecutionCredential = createServerFn({ method: "POST" })
  .validator(
    z
      .object({
        connectionId: z.string().min(1),
        pat: z.string().min(1),
        scopes: z.array(z.string().min(1)).min(1),
        repositories: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  )
  .handler(async ({ data }): Promise<Result<ForgejoConnectionList>> => {
    const response = await handleProviderRequest(
      "forgejo.connections",
      forgejoApiRequest(`/connections/${data.connectionId}/credentials/execution`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    );
    if (!response.ok) return forgejoFailure(response);
    return readConnectionList();
  });

export const revokeForgejoExecutionCredential = createServerFn({ method: "POST" })
  .validator(z.object({ connectionId: z.string().min(1) }).strict())
  .handler(async ({ data }): Promise<Result<ForgejoConnectionList>> => {
    const response = await handleProviderRequest(
      "forgejo.connections",
      forgejoApiRequest(`/connections/${data.connectionId}/credentials/execution/revoke`, {
        method: "POST",
        body: "{}",
      }),
    );
    if (!response.ok) return forgejoFailure(response);
    return readConnectionList();
  });

export const rotateForgejoWebhookSecret = createServerFn({ method: "POST" })
  .validator(
    z.object({ connectionId: z.string().min(1), webhookAdminPat: z.string().min(1) }).strict(),
  )
  .handler(async ({ data }): Promise<Result<ForgejoConnectionList>> => {
    const response = await handleProviderRequest(
      "forgejo.connections",
      forgejoApiRequest(`/connections/${data.connectionId}/credentials/webhook_secret/rotate`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    );
    if (!response.ok) return forgejoFailure(response);
    return readConnectionList();
  });

export const previewForgejoDisconnect = createServerFn({ method: "GET" })
  .validator(z.object({ connectionId: z.string().min(1) }).strict())
  .handler(
    async ({ data }): Promise<Result<ForgejoDisconnectImpact>> =>
      forgejoResult(
        await handleProviderRequest(
          "forgejo.connections",
          forgejoApiRequest(`/connections/${data.connectionId}/impact`),
        ),
        (body) => disconnectImpactSchema.parse(body),
      ),
  );

export const disconnectForgejoConnection = createServerFn({ method: "POST" })
  .validator(
    z
      .object({ connectionId: z.string().min(1), webhookAdminPat: z.string().min(1).optional() })
      .strict(),
  )
  .handler(
    async ({ data }): Promise<Result<ForgejoDisconnectResult>> =>
      forgejoResult(
        await handleProviderRequest(
          "forgejo.connections",
          forgejoApiRequest(`/connections/${data.connectionId}/disconnect`, {
            method: "POST",
            body: JSON.stringify(
              data.webhookAdminPat === undefined ? {} : { webhookAdminPat: data.webhookAdminPat },
            ),
          }),
        ),
        (body) => disconnectResultSchema.parse(body),
      ),
  );

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
