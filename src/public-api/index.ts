import { randomUUID } from "node:crypto";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import { isDatabaseUnavailableError } from "../db/errors.js";
import { logger } from "../logger.js";
import type {
  DispatchManualRunResult,
  InstallConfigurationResult,
  IssueEnrollmentTokenResult,
  PublicAuthorization,
  PublicOperations,
} from "../public-operations/index.js";
import {
  DispatchedManualRunSchema,
  EnrollmentTokenSchema,
  InstalledConfigurationSchema,
  ProblemSchema,
  type Problem,
} from "./contracts.js";
import { publicOpenApiDocument } from "./openapi.js";
import {
  publicOperation,
  publicOperationManifest,
  type PublicOperationId,
} from "./operation-manifest.js";

export type { PublicOperationId } from "./operation-manifest.js";

type PublicOperationResult =
  | InstallConfigurationResult
  | DispatchManualRunResult
  | IssueEnrollmentTokenResult;

export interface PublicApi {
  handle(request: Request): Promise<Response>;
  handleOperation(id: PublicOperationId, request: Request): Promise<Response>;
  handleLegacyOperation(id: PublicOperationId, request: Request): Promise<Response>;
  openapi(): Response;
}

export type PublicApiComposition =
  | { status: "enabled"; authenticator: OperationAuthenticator }
  | { status: "unavailable" };

export function createPublicApi(
  composition: PublicApiComposition,
  operations: PublicOperations | null,
): PublicApi {
  if (composition.status === "enabled" && operations === null) {
    throw new Error("enabled public API requires application operations");
  }
  return {
    handle(request) {
      const url = new URL(request.url);
      const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
      const pathRoutes = publicOperationManifest.filter((route) => route.path === url.pathname);
      if (pathRoutes.length === 0) {
        return Promise.resolve(
          problem(
            requestId,
            404,
            "not_found",
            "Not found",
            "No canonical API route matches this path.",
          ),
        );
      }
      const route = pathRoutes.find(
        (candidate) => candidate.method.toUpperCase() === request.method.toUpperCase(),
      );
      if (route === undefined) {
        const response = problem(
          requestId,
          405,
          "method_not_allowed",
          "Method not allowed",
          "Use one of the methods listed in the Allow response header.",
        );
        response.headers.set(
          "allow",
          pathRoutes.map(({ method }) => method.toUpperCase()).join(", "),
        );
        return Promise.resolve(response);
      }
      return executeSafely(route.id, request, requestId, "canonical", composition, operations);
    },
    handleOperation(id, request) {
      const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
      return executeSafely(id, request, requestId, "canonical", composition, operations);
    },
    handleLegacyOperation(id, request) {
      const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
      return executeSafely(id, request, requestId, "legacy", composition, operations);
    },
    openapi() {
      return Response.json(publicOpenApiDocument, {
        headers: { "cache-control": "public, max-age=300" },
      });
    },
  };
}

type ResponseMode = "canonical" | "legacy";

async function executeSafely(
  id: PublicOperationId,
  request: Request,
  requestId: string,
  mode: ResponseMode,
  composition: PublicApiComposition,
  operations: PublicOperations | null,
): Promise<Response> {
  try {
    if (composition.status === "unavailable" || operations === null) {
      return mode === "legacy"
        ? legacyError(503, "auth_unavailable")
        : problem(
            requestId,
            503,
            "infrastructure_unavailable",
            "Service unavailable",
            "Public API authentication or storage is currently unavailable.",
          );
    }
    return await execute(id, request, requestId, mode, composition.authenticator, operations);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) return infrastructureProblem(requestId, mode);
    logger.error({ err: error, requestId, operationId: id }, "public API internal error");
    return mode === "legacy"
      ? legacyError(500, "internal_error")
      : problem(
          requestId,
          500,
          "internal_error",
          "Internal server error",
          "The operation failed unexpectedly. Contact the Hub operator with the request ID.",
        );
  }
}

async function execute(
  id: PublicOperationId,
  request: Request,
  requestId: string,
  mode: ResponseMode,
  authenticator: OperationAuthenticator,
  operations: PublicOperations,
): Promise<Response> {
  const definition = publicOperation(id);
  const scope = definition.scope;
  let authorization;
  try {
    authorization = await authenticator.authorize(request, scope);
  } catch (error) {
    if (!isDatabaseUnavailableError(error)) throw error;
    return mode === "legacy"
      ? legacyError(503, "auth_unavailable")
      : problem(
          requestId,
          503,
          "authentication_unavailable",
          "Authentication unavailable",
          "API-key authentication is currently unavailable. Retry the request later.",
        );
  }
  if (authorization.status === "unauthorized") {
    return mode === "legacy"
      ? legacyError(401, "unauthorized")
      : problem(
          requestId,
          401,
          "unauthorized",
          "Authentication required",
          "Provide an active Paseo API key in the Authorization: Bearer header.",
        );
  }
  if (authorization.status === "forbidden") {
    return mode === "legacy"
      ? legacyError(403, "forbidden")
      : problem(
          requestId,
          403,
          "insufficient_scope",
          "Insufficient scope",
          `This operation requires the ${scope} scope.`,
        );
  }
  const access: PublicAuthorization = authorization.access;
  let input: unknown;
  if (definition.requestSchema !== undefined) {
    const parsedBody = await readJson(request);
    if (!parsedBody.success) {
      return mode === "legacy"
        ? legacyError(400, "invalid_request")
        : problem(
            requestId,
            400,
            "invalid_json",
            "Invalid JSON",
            "Send a JSON request body using Content-Type: application/json.",
          );
    }
    const parsed = definition.requestSchema.safeParse(parsedBody.value);
    if (!parsed.success) {
      return mode === "legacy"
        ? legacyError(400, "invalid_request")
        : validationProblem(requestId, parsed.error.issues);
    }
    input = parsed.data;
  }
  const result = await definition.invoke(operations, access, input);
  switch (definition.resultMapping) {
    case "configuration":
      if (!isInstallationResult(result)) throw new Error("invalid configuration operation result");
      return installationResponse(requestId, result, mode);
    case "manual-run":
      if (!isManualRunResult(result)) throw new Error("invalid manual-run operation result");
      return manualRunResponse(requestId, result, mode);
    case "enrollment-token":
      if (!isEnrollmentResult(result)) throw new Error("invalid enrollment operation result");
      return enrollmentResponse(requestId, result, mode);
  }
  return assertNever(definition.resultMapping);
}

async function readJson(
  request: Request,
): Promise<{ success: true; value: unknown } | { success: false }> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { success: false };
  }
  try {
    return { success: true, value: await request.json() };
  } catch {
    return { success: false };
  }
}

function validationProblem(
  requestId: string,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Response {
  return problem(
    requestId,
    400,
    "invalid_request",
    "Invalid request",
    "The request body contains invalid fields.",
    issues.map((issue) => ({
      path: issue.path.flatMap((part) => (typeof part === "symbol" ? [] : [part])),
      message: issue.message,
    })),
  );
}

function installationResponse(
  requestId: string,
  result: InstallConfigurationResult,
  mode: ResponseMode,
): Response {
  if (mode === "legacy") return legacyInstallationResponse(result);
  switch (result.status) {
    case "installed":
      return success(requestId, 201, InstalledConfigurationSchema, {
        projectSlug: result.projectSlug,
        versionId: result.versionId,
        version: result.version,
        active: result.active,
      });
    case "project_not_found":
      return problem(
        requestId,
        404,
        "project_not_found",
        "Project not found",
        "No active project with that slug exists in the API key's organization.",
      );
    case "invalid_yaml":
      return problem(
        requestId,
        422,
        "invalid_yaml",
        "Invalid YAML",
        "Correct the YAML syntax and submit the configuration again.",
        result.issues,
      );
    case "invalid_document":
      return problem(
        requestId,
        422,
        "invalid_configuration_document",
        "Invalid configuration document",
        "Correct the deployment metadata and submit the configuration again.",
        result.issues,
      );
    case "invalid_bundle":
      return problem(
        requestId,
        422,
        "invalid_configuration_bundle",
        "Invalid configuration bundle",
        "Supply exactly the prompt partial files referenced by the YAML configuration.",
        result.issues,
      );
    case "invalid_configuration":
      return problem(
        requestId,
        422,
        "invalid_configuration",
        "Invalid configuration",
        `Configuration revision ${result.versionId} was recorded but not activated.`,
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function manualRunResponse(
  requestId: string,
  result: DispatchManualRunResult,
  mode: ResponseMode,
): Response {
  if (mode === "legacy") return legacyManualRunResponse(result);
  switch (result.status) {
    case "dispatched":
      return success(requestId, 200, DispatchedManualRunSchema, {
        deliveryKey: result.deliveryKey,
        providerEventReceiptId: result.providerEventReceiptId,
        triggerRunId: result.triggerRunId,
        configuredTriggerName: result.configuredTriggerName,
        workflowStatus: result.workflowStatus,
      });
    case "project_not_found":
      return problem(
        requestId,
        404,
        "project_not_found",
        "Project not found",
        "No active project with that slug exists in the API key's organization.",
      );
    case "actor_forbidden":
      return problem(
        requestId,
        403,
        "actor_forbidden",
        "Actor forbidden",
        "The configured manual trigger does not allow this actor.",
      );
    case "configuration_not_found":
      return problem(
        requestId,
        404,
        "configuration_not_found",
        "Configuration not found",
        "The requested configuration revision is not available.",
      );
    case "trigger_not_found":
      return problem(
        requestId,
        404,
        "trigger_not_found",
        "Trigger not found",
        "The active configuration has no matching manual trigger.",
      );
    case "expected_configuration_not_current":
      return problem(
        requestId,
        409,
        "configuration_changed",
        "Configuration changed",
        "expectedVersionId is not the configuration version selected for this delivery.",
      );
    case "daemon_offline":
      return problem(
        requestId,
        409,
        "daemon_offline",
        "Daemon offline",
        "The selected daemon is not connected. Reconnect it before retrying.",
      );
    case "invalid_input":
      return problem(
        requestId,
        400,
        "invalid_input",
        "Invalid trigger input",
        `Run ${result.triggerRunId} rejected the submitted input.`,
        result.issues,
      );
    case "dispatch_conflict":
      return problem(
        requestId,
        409,
        "dispatch_conflict",
        "Run not dispatched",
        "The durable event exists but no matching run is available yet. Retry with the same deliveryKey.",
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function enrollmentResponse(
  requestId: string,
  result: IssueEnrollmentTokenResult,
  mode: ResponseMode,
): Response {
  if (mode === "legacy") {
    return result.status === "issued"
      ? Response.json(
          { token: result.token, expiresAt: result.expiresAt.toISOString() },
          { status: 201 },
        )
      : legacyError(
          result.status === "credential_revoked" ? 401 : 503,
          result.status === "credential_revoked" ? "unauthorized" : "database_unavailable",
        );
  }
  switch (result.status) {
    case "issued":
      return success(requestId, 201, EnrollmentTokenSchema, {
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
      });
    case "credential_revoked":
      return problem(
        requestId,
        401,
        "unauthorized",
        "Authentication required",
        "The API key was revoked before the enrollment token could be issued.",
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function infrastructureProblem(requestId: string, mode: ResponseMode = "canonical"): Response {
  if (mode === "legacy") return legacyError(503, "database_unavailable");
  return problem(
    requestId,
    503,
    "infrastructure_unavailable",
    "Service unavailable",
    "The operation could not reach durable storage. Retry the request later.",
  );
}

function success(
  requestId: string,
  status: number,
  schema: { parse(value: unknown): unknown },
  value: unknown,
): Response {
  return Response.json(schema.parse(value), { status, headers: { "x-request-id": requestId } });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled public operation result: ${String(value)}`);
}

function problem(
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
  issues?: readonly { path: readonly (string | number)[]; message: string }[],
): Response {
  const body: Problem = ProblemSchema.parse({
    type: `https://paseo.sh/problems/${code.replaceAll("_", "-")}`,
    title,
    status,
    detail,
    code,
    requestId,
    ...(issues === undefined ? {} : { issues }),
  });
  return Response.json(body, {
    status,
    headers: {
      "content-type": "application/problem+json",
      "x-request-id": requestId,
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    },
  });
}

function legacyError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return Response.json(
    { error, ...extra },
    { status, ...(status === 401 ? { headers: { "www-authenticate": "Bearer" } } : {}) },
  );
}

function legacyInstallationResponse(result: InstallConfigurationResult): Response {
  switch (result.status) {
    case "installed":
      return Response.json(
        {
          projectSlug: result.projectSlug,
          versionId: result.versionId,
          version: result.version,
          active: true,
        },
        { status: 201 },
      );
    case "project_not_found":
      return legacyError(404, "project_not_found");
    case "invalid_yaml":
      return legacyError(422, "invalid_yaml");
    case "invalid_document":
      return legacyError(422, "invalid_config");
    case "invalid_bundle":
      return legacyError(422, "invalid_config");
    case "invalid_configuration":
      return legacyError(422, "invalid_config", { versionId: result.versionId });
    case "infrastructure_unavailable":
      return legacyError(503, "database_unavailable");
  }
  return assertNever(result);
}

function legacyManualRunResponse(result: DispatchManualRunResult): Response {
  switch (result.status) {
    case "dispatched":
      return Response.json({
        deliveryKey: result.deliveryKey,
        providerEventReceiptId: result.providerEventReceiptId,
        triggerRunId: result.triggerRunId,
        configuredTriggerName: result.configuredTriggerName,
        workflowStatus: result.workflowStatus,
      });
    case "project_not_found":
      return legacyError(404, "project_not_found");
    case "actor_forbidden":
      return legacyError(403, "actor_forbidden");
    case "daemon_offline":
      return legacyError(409, "daemon_offline");
    case "expected_configuration_not_current":
      return legacyError(409, "expected_config_version_not_current");
    case "configuration_not_found":
      return legacyError(404, "manual_config_not_found");
    case "trigger_not_found":
      return legacyError(404, "manual_trigger_not_found");
    case "invalid_input":
      return legacyError(400, "invalid_input", {
        reason: `rejected_input:${result.configuredTriggerName}:${result.issues[0]?.message ?? "invalid input"}`,
        providerEventReceiptId: result.providerEventReceiptId,
        triggerRunId: result.triggerRunId,
        configuredTriggerName: result.configuredTriggerName,
      });
    case "dispatch_conflict":
      return legacyError(409, "manual_run_not_dispatched");
    case "infrastructure_unavailable":
      return legacyError(503, "database_unavailable");
  }
  return assertNever(result);
}

function isInstallationResult(result: PublicOperationResult): result is InstallConfigurationResult {
  return [
    "installed",
    "project_not_found",
    "invalid_yaml",
    "invalid_document",
    "invalid_bundle",
    "invalid_configuration",
    "infrastructure_unavailable",
  ].includes(result.status);
}

function isManualRunResult(result: PublicOperationResult): result is DispatchManualRunResult {
  return [
    "dispatched",
    "project_not_found",
    "actor_forbidden",
    "daemon_offline",
    "expected_configuration_not_current",
    "configuration_not_found",
    "trigger_not_found",
    "invalid_input",
    "dispatch_conflict",
    "infrastructure_unavailable",
  ].includes(result.status);
}

function isEnrollmentResult(result: PublicOperationResult): result is IssueEnrollmentTokenResult {
  return ["issued", "credential_revoked", "infrastructure_unavailable"].includes(result.status);
}

export { publicOpenApiDocument } from "./openapi.js";
export { publicOperationManifest } from "./operation-manifest.js";
export * from "./contracts.js";
