import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
import { getApplication } from "../server/runtime.js";
import {
  accountStateSchema,
  invitationRoleSchema,
  organizationRoleSchema,
} from "./organization-contract.js";
import { PASSWORD_MIN_LENGTH } from "./instance-policy.js";
import { API_KEY_SCOPES, apiKeyScopeSchema } from "./api-key-contract.js";
import { parseEntitlementDenial, type EntitlementDenialPayload } from "../entitlements/denial.js";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH),
});
const signUpSchema = credentialsSchema.extend({
  name: z.string().trim().min(1),
  invitation: z.string().min(1).optional(),
});
const invitationSchema = z.object({ invitation: z.string().optional() });
const createOrganizationSchema = z.object({ name: z.string().trim().min(1).max(100) });
const selectOrganizationSchema = z.object({ organizationId: z.string().min(1) });
const createInvitationSchema = z.object({ email: z.string().email(), role: invitationRoleSchema });
const invitationIdSchema = z.object({ invitationId: z.string().min(1) });
const changeRoleSchema = z.object({ memberId: z.string().min(1), role: organizationRoleSchema });
const memberIdSchema = z.object({ memberId: z.string().min(1) });
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH),
});
const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(apiKeyScopeSchema).min(1),
});
const apiKeyIdSchema = z.object({ id: z.string().uuid() });
const apiKeySummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(apiKeyScopeSchema),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
const cliCredentialSummarySchema = z.object({
  id: z.string().uuid(),
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
const apiKeyCreateResultSchema = z.object({
  key: apiKeySummarySchema,
  secret: z.string().min(1),
});

export const accountState = createServerFn({ method: "GET" })
  .validator(invitationSchema)
  .handler(async ({ data }): Promise<Result<z.infer<typeof accountStateSchema>>> => {
    const request = getRequest();
    const url = new URL("/api/auth/paseo/state", request.url);
    if (data.invitation !== undefined) url.searchParams.set("invitation", data.invitation);
    try {
      const response = await (
        await getApplication()
      ).browserAccount?.(new Request(url, { headers: request.headers }));
      if (response === undefined || !response.ok) {
        return respondError({ message: "We couldn't load your Paseo Hub account." });
      }
      return respondOk(accountStateSchema.parse(await response.json()));
    } catch {
      return respondError({ message: "We couldn't load your Paseo Hub account." });
    }
  });

export const signIn = createServerFn({ method: "POST" })
  .validator(credentialsSchema)
  .handler(async ({ data }): Promise<Result<Record<string, never>>> => {
    try {
      const application = await getApplication();
      if (application.signInEmail === undefined) throw new Error("auth unavailable");
      await application.signInEmail(data, getRequest().headers);
      return respondOk({});
    } catch (error) {
      if (isAPIError(error) && error.body?.code === "INVALID_EMAIL_OR_PASSWORD") {
        return respondError({ message: "The email or password is incorrect." });
      }
      return respondError({ message: "We couldn't sign you in. Try again." });
    }
  });

export const signUp = createServerFn({ method: "POST" })
  .validator(signUpSchema)
  .handler(async ({ data }): Promise<Result<Record<string, never>>> => {
    try {
      const application = await getApplication();
      if (application.signUpEmail === undefined) throw new Error("auth unavailable");
      await application.signUpEmail(
        { name: data.name, email: data.email, password: data.password },
        getRequest().headers,
        data.invitation,
      );
      return respondOk({});
    } catch {
      return respondError({ message: "We couldn't create that account." });
    }
  });

export const signOut = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<Record<string, never>>> => {
    try {
      const application = await getApplication();
      if (application.signOut === undefined) throw new Error("auth unavailable");
      await application.signOut(getRequest().headers);
      return respondOk({});
    } catch {
      return respondError({ message: "We couldn't sign you out." });
    }
  },
);

export const changePassword = createServerFn({ method: "POST" })
  .validator(passwordChangeSchema)
  .handler(async ({ data }): Promise<Result<Record<string, never>>> => {
    try {
      const application = await getApplication();
      if (application.changePassword === undefined) throw new Error("auth unavailable");
      await application.changePassword(data, getRequest().headers);
      return respondOk({});
    } catch (error) {
      if (isAPIError(error) && error.body?.code === "INVALID_PASSWORD") {
        return respondError({ message: "The current password is incorrect." });
      }
      return respondError({ message: "We couldn't change your password." });
    }
  });

export const listApiKeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<
    Result<{
      keys: z.infer<typeof apiKeySummarySchema>[];
      cliCredentials: z.infer<typeof cliCredentialSummarySchema>[];
    }>
  > => {
    const response = await sendAccountQuery("/api/auth/paseo/api-keys");
    if (response === undefined) return respondError({ message: "We couldn't load API keys." });
    if (!response.ok) return respondError({ message: "We couldn't load API keys." });
    try {
      return respondOk(
        z
          .object({
            keys: z.array(apiKeySummarySchema),
            cliCredentials: z.array(cliCredentialSummarySchema),
          })
          .parse(await response.json()),
      );
    } catch {
      return respondError({ message: "We couldn't load API keys." });
    }
  },
);

export const createApiKey = createServerFn({ method: "POST" })
  .validator(apiKeyCreateSchema)
  .handler(async ({ data }): Promise<Result<z.infer<typeof apiKeyCreateResultSchema>>> => {
    const response = await sendAccountCommand("/api/auth/paseo/api-keys", data);
    if (response === undefined)
      return respondError({ message: "We couldn't create that API key." });
    if (!response.ok) return respondError({ message: "We couldn't create that API key." });
    try {
      const result = apiKeyCreateResultSchema.parse(await response.json());
      return respondOk(result);
    } catch {
      return respondError({ message: "We couldn't create that API key." });
    }
  });

export const revokeApiKey = createServerFn({ method: "POST" })
  .validator(apiKeyIdSchema)
  .handler(async ({ data }): Promise<Result<Record<string, never>>> => {
    const response = await sendAccountCommand("/api/auth/paseo/revoke-api-key", data);
    if (response === undefined || !response.ok) {
      return respondError({ message: "We couldn't revoke that API key." });
    }
    return respondOk({});
  });

export const revokeCliCredential = createServerFn({ method: "POST" })
  .validator(apiKeyIdSchema)
  .handler(async ({ data }): Promise<Result<Record<string, never>>> => {
    const response = await sendAccountCommand("/api/auth/paseo/revoke-cli-credential", data);
    if (response === undefined || !response.ok) {
      return respondError({ message: "We couldn't revoke that CLI login." });
    }
    return respondOk({});
  });

type AccountCommandResult = Result<{
  state: "sessionExpired" | "organizationRequired" | "complete";
}>;

type CreateOrganizationCommandResult = Result<{
  state: "sessionExpired" | "complete";
  organizationSlug?: string;
}>;

export const createOrganization = createServerFn({ method: "POST" })
  .validator(createOrganizationSchema)
  .handler(async ({ data }): Promise<CreateOrganizationCommandResult> => {
    const response = await sendAccountCommand("/api/auth/paseo/create-organization", data);
    if (response === undefined) {
      return respondError({ message: "We couldn't create that organization." });
    }
    if (response.status === 401) return respondOk({ state: "sessionExpired" });
    if (!response.ok) return respondError({ message: "We couldn't create that organization." });
    const result = z.object({ organizationSlug: z.string().min(1) }).parse(await response.json());
    return respondOk({ state: "complete", organizationSlug: result.organizationSlug });
  });

export const selectOrganization = createServerFn({ method: "POST" })
  .validator(selectOrganizationSchema)
  .handler(async ({ data }): Promise<AccountCommandResult> => {
    const response = await sendAccountCommand("/api/auth/paseo/select-organization", data);
    if (response === undefined) {
      return respondError({ message: "We couldn't switch organizations." });
    }
    if (response.status === 401) return respondOk({ state: "sessionExpired" });
    if (!response.ok) return respondError({ message: "We couldn't switch organizations." });
    return respondOk({ state: "complete" });
  });

export const createInvitation = createServerFn({ method: "POST" })
  .validator(createInvitationSchema)
  .handler(async ({ data }): Promise<AccountCommandResult> => {
    const response = await sendAccountCommand("/api/auth/paseo/create-invitation", data);
    if (response === undefined) {
      return respondError({ message: "We couldn't create that invitation." });
    }
    if (response.status === 401) return respondOk({ state: "sessionExpired" });
    if (response.status === 403) return respondOk({ state: "organizationRequired" });
    if (response.status === 409) {
      const denial = parseEntitlementDenial(await response.json().catch(() => undefined));
      if (denial !== undefined) return respondError({ message: invitationDenialMessage(denial) });
    }
    if (!response.ok) return respondError({ message: "We couldn't create that invitation." });
    return respondOk({ state: "complete" });
  });

function invitationDenialMessage(denial: EntitlementDenialPayload): string {
  // Neutral on remedy: raising a limit is the instance operator's job, not the org owner's, and
  // this renders on self-hosted too where there is nothing to upgrade. The Usage page shows the
  // limit and current use; who can change it depends on the deployment.
  if (denial.entitlement === "canInviteMembers") {
    return "Inviting members isn't enabled for this organization. See the Usage page for its limits.";
  }
  return `Seat limit reached — ${denial.current} of ${denial.limit} seats are in use. See the Usage page for this organization's limits.`;
}

export const cancelInvitation = createServerFn({ method: "POST" })
  .validator(invitationIdSchema)
  .handler(async ({ data }): Promise<AccountCommandResult> => {
    const response = await sendAccountCommand("/api/auth/paseo/cancel-invitation", data);
    if (response === undefined) {
      return respondError({ message: "We couldn't cancel that invitation." });
    }
    if (response.status === 401) return respondOk({ state: "sessionExpired" });
    if (response.status === 403) return respondOk({ state: "organizationRequired" });
    if (!response.ok) return respondError({ message: "We couldn't cancel that invitation." });
    return respondOk({ state: "complete" });
  });

export const acceptInvitation = createServerFn({ method: "POST" })
  .validator(invitationIdSchema)
  .handler(async ({ data }): Promise<AccountCommandResult> => {
    const response = await sendAccountCommand("/api/auth/paseo/accept-invitation", data);
    if (response === undefined) return respondError({ message: "This invitation is unavailable." });
    if (response.status === 401) return respondOk({ state: "sessionExpired" });
    if (!response.ok) return respondError({ message: "This invitation is unavailable." });
    return respondOk({ state: "complete" });
  });

export const changeMemberRole = createServerFn({ method: "POST" })
  .validator(changeRoleSchema)
  .handler(async ({ data }): Promise<AccountCommandResult> => {
    const response = await sendAccountCommand("/api/auth/paseo/change-member-role", data);
    if (response === undefined) return respondError({ message: "We couldn't change that role." });
    if (response.status === 401) return respondOk({ state: "sessionExpired" });
    if (response.status === 403) return respondOk({ state: "organizationRequired" });
    if (!response.ok) return respondError({ message: "We couldn't change that role." });
    return respondOk({ state: "complete" });
  });

export const removeMember = createServerFn({ method: "POST" })
  .validator(memberIdSchema)
  .handler(async ({ data }): Promise<AccountCommandResult> => {
    const response = await sendAccountCommand("/api/auth/paseo/remove-member", data);
    if (response === undefined) return respondError({ message: "We couldn't remove that member." });
    if (response.status === 401) return respondOk({ state: "sessionExpired" });
    if (response.status === 403) return respondOk({ state: "organizationRequired" });
    if (!response.ok) return respondError({ message: "We couldn't remove that member." });
    return respondOk({ state: "complete" });
  });

async function sendAccountCommand(path: string, data: unknown): Promise<Response | undefined> {
  const incoming = getRequest();
  try {
    const headers = new Headers(incoming.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    return await (
      await getApplication()
    ).browserAccount?.(
      new Request(new URL(path, incoming.url), {
        method: "POST",
        headers,
        body: JSON.stringify(data),
      }),
    );
  } catch {
    return undefined;
  }
}

async function sendAccountQuery(path: string): Promise<Response | undefined> {
  const incoming = getRequest();
  try {
    return await (
      await getApplication()
    ).browserAccount?.(new Request(new URL(path, incoming.url), { headers: incoming.headers }));
  } catch {
    return undefined;
  }
}

export { API_KEY_SCOPES };
