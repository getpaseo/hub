import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
import { getApplication } from "../server/runtime.js";

const daemonSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  status: z.enum(["active", "revoked"]),
  presence: z.enum(["offline", "connected"]),
  connectedAt: z.string().datetime().nullable(),
  lastSeenAt: z.string().datetime(),
  registeredAt: z.string().datetime(),
});
const daemonListSchema = z.object({
  daemons: z.array(daemonSchema),
  canManage: z.boolean(),
});
const renameSchema = z.object({ daemonId: z.string().uuid(), slug: z.string() });
const daemonIdSchema = z.object({ daemonId: z.string().uuid() });
const organizationScopeSchema = z.object({ organizationSlug: z.string().min(1) });
const scopedRenameSchema = organizationScopeSchema.extend(renameSchema.shape);
const scopedDaemonIdSchema = organizationScopeSchema.extend(daemonIdSchema.shape);

export type BrowserDaemon = z.infer<typeof daemonSchema>;
export interface DaemonCommand {
  state: "complete" | "sessionExpired" | "organizationRequired";
}

export const daemonList = createServerFn({ method: "GET" })
  .validator(organizationScopeSchema)
  .handler(async ({ data }): Promise<Result<z.infer<typeof daemonListSchema>>> => {
    try {
      const response = await (
        await getApplication()
      ).operations.handleOrganizationDaemons(
        operationRequest("GET", "/organization/daemons", undefined, data.organizationSlug),
      );
      if (!response.ok) {
        return respondError({ message: "We couldn't load this organization's daemons." });
      }
      return respondOk(daemonListSchema.parse(await response.json()));
    } catch {
      return respondError({ message: "We couldn't load this organization's daemons." });
    }
  });

export const renameDaemon = createServerFn({ method: "POST" })
  .validator(scopedRenameSchema)
  .handler(async ({ data }): Promise<Result<DaemonCommand>> => {
    try {
      const response = await (
        await getApplication()
      ).operations.handleOrganizationDaemonRename(
        operationRequest(
          "POST",
          "/organization/daemons/rename",
          {
            slug: data.slug,
          },
          data.organizationSlug,
        ),
        data.daemonId,
      );
      if (response.status === 401) return respondOk({ state: "sessionExpired" });
      if (response.status === 403) {
        const failure = z.object({ error: z.string() }).safeParse(await response.json());
        if (failure.success && failure.data.error === "organization_required") {
          return respondOk({ state: "organizationRequired" });
        }
      }
      if (response.status === 409) {
        const failure = z
          .object({ error: z.literal("daemon_slug_conflict"), slug: z.string() })
          .safeParse(await response.json());
        if (failure.success) {
          return respondError({
            message: `The daemon slug “${failure.data.slug}” is already in use. Choose another slug.`,
          });
        }
      }
      if (!response.ok) return respondError({ message: "We couldn't rename that daemon." });
      return respondOk({ state: "complete" });
    } catch {
      return respondError({ message: "We couldn't rename that daemon." });
    }
  });

export const revokeDaemon = createServerFn({ method: "POST" })
  .validator(scopedDaemonIdSchema)
  .handler(async ({ data }): Promise<Result<DaemonCommand>> => {
    try {
      const response = await (
        await getApplication()
      ).operations.handleOrganizationDaemonRevocation(
        operationRequest("POST", "/organization/daemons/revoke", {}, data.organizationSlug),
        data.daemonId,
      );
      if (response.status === 401) return respondOk({ state: "sessionExpired" });
      if (response.status === 403) {
        const failure = z.object({ error: z.string() }).safeParse(await response.json());
        if (failure.success && failure.data.error === "organization_required") {
          return respondOk({ state: "organizationRequired" });
        }
      }
      if (!response.ok) return respondError({ message: "We couldn't revoke that daemon." });
      return respondOk({ state: "complete" });
    } catch {
      return respondError({ message: "We couldn't revoke that daemon." });
    }
  });

function operationRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  organizationSlug?: string,
): Request {
  const incoming = getRequest();
  const headers = new Headers(incoming.headers);
  headers.delete("content-length");
  if (body !== undefined) headers.set("content-type", "application/json");
  const url = new URL(path, incoming.url);
  if (organizationSlug !== undefined) url.searchParams.set("organizationSlug", organizationSlug);
  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
