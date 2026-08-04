import type { ApiKeyScope } from "./api-key-contract.js";
import type { OperationAuthorization, OperationAuthorizationResult } from "./api-keys.js";

export interface OperationAuthenticator {
  authorize(request: Request, requiredScope: ApiKeyScope): Promise<OperationAuthorizationResult>;
}

export async function requireOperation(
  authenticator: OperationAuthenticator | undefined,
  request: Request,
  scope: ApiKeyScope,
): Promise<OperationAuthorization | Response> {
  if (authenticator === undefined) return Response.json({ error: "unauthorized" }, { status: 401 });
  const result = await authenticator.authorize(request, scope);
  if (result.status === "unauthorized") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (result.status === "forbidden") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return result.access;
}
