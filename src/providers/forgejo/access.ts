import { ProductRequestError } from "../../auth/organization-access.js";
import type { AuthServer } from "../../auth/server.js";
import {
  ForgejoContractError,
  type ForgejoAccess,
  type ForgejoAccessResolver,
} from "./instances.js";

export function createForgejoAccessResolver(auth: AuthServer): ForgejoAccessResolver {
  return {
    async resolve(request) {
      try {
        const account = await auth.resolveAccount(request);
        const access: ForgejoAccess = {
          userId: account.account.id,
          isInstanceOperator: account.isInstanceOperator,
          organizationId: account.session.activeOrganizationId,
          organizationRole: null,
        };
        try {
          const organization = await auth.resolveOrganizationAccess(request);
          access.organizationId = organization.organization.id;
          access.organizationRole = organization.membership.role;
        } catch (error) {
          if (!isOrganizationRequired(error)) throw error;
        }
        return access;
      } catch (error) {
        if (error instanceof ForgejoContractError) throw error;
        if (error instanceof ProductRequestError) {
          throw new ForgejoContractError(
            "forbidden",
            error.message === "unauthenticated" ? 401 : 403,
            error.message,
          );
        }
        throw new ForgejoContractError("forbidden", 403, "access denied");
      }
    },
  };
}

function isOrganizationRequired(error: unknown): boolean {
  return error instanceof ProductRequestError && error.message === "organization_required";
}
