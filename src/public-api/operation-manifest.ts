import type { ApiKeyScope } from "../auth/api-key-contract.js";
import type {
  DispatchManualRunResult,
  InstallConfigurationResult,
  IssueEnrollmentTokenResult,
  PublicOperations,
} from "../public-operations/index.js";
import {
  DispatchManualRunRequestSchema,
  DispatchedManualRunSchema,
  EnrollmentTokenSchema,
  InstallConfigurationRequestSchema,
  InstalledConfigurationSchema,
} from "./contracts.js";

export type PublicOperationId =
  | "installConfiguration"
  | "dispatchManualRun"
  | "issueEnrollmentToken";

export interface PublicOperationDefinition {
  id: PublicOperationId;
  method: "post";
  path: string;
  legacyPath: string;
  scope: ApiKeyScope;
  requestSchema?: typeof InstallConfigurationRequestSchema | typeof DispatchManualRunRequestSchema;
  successSchema:
    | typeof InstalledConfigurationSchema
    | typeof DispatchedManualRunSchema
    | typeof EnrollmentTokenSchema;
  successStatus: 200 | 201;
  resultMapping: "configuration" | "manual-run" | "enrollment-token";
  summary: string;
  description: string;
  tag: "Configurations" | "Runs" | "Daemons";
  responses: Readonly<Record<number, string>>;
  invoke(
    operations: PublicOperations,
    authorization: Parameters<PublicOperations["issueEnrollmentToken"]>[0],
    input: unknown,
  ): Promise<InstallConfigurationResult | DispatchManualRunResult | IssueEnrollmentTokenResult>;
}

export const publicOperationManifest: readonly PublicOperationDefinition[] = [
  {
    id: "installConfiguration",
    method: "post",
    path: "/api/v1/configurations/install",
    legacyPath: "/api/configurations/install",
    scope: "configuration:install",
    requestSchema: InstallConfigurationRequestSchema,
    successSchema: InstalledConfigurationSchema,
    successStatus: 201,
    resultMapping: "configuration",
    summary: "Install and activate configuration",
    description:
      "Validates YAML, strips optional project deployment metadata, records a configuration revision, and atomically activates it.",
    tag: "Configurations",
    responses: {
      201: "The new configuration revision is active.",
      400: "The JSON request is malformed or has invalid fields.",
      401: "The API key is missing, malformed, or revoked.",
      403: "The API key lacks configuration:install.",
      404: "The project does not exist in the key's organization.",
      422: "The YAML or Hub configuration is invalid.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.installConfiguration(
        authorization,
        InstallConfigurationRequestSchema.parse(input),
      ),
  },
  {
    id: "dispatchManualRun",
    method: "post",
    path: "/api/v1/manual-runs",
    legacyPath: "/api/manual-runs",
    scope: "runs:dispatch",
    requestSchema: DispatchManualRunRequestSchema,
    successSchema: DispatchedManualRunSchema,
    successStatus: 200,
    resultMapping: "manual-run",
    summary: "Dispatch a manual run",
    description:
      "Uses deliveryKey as caller-supplied request identity in the existing durable manual-event path.",
    tag: "Runs",
    responses: {
      200: "The durable manual event resolved to a run.",
      400: "The JSON request or trigger input is invalid.",
      401: "The API key is missing, malformed, or revoked.",
      403: "The API key lacks runs:dispatch or the actor is forbidden.",
      404: "The project, configuration, or manual trigger does not exist.",
      409: "The existing manual event path could not resolve a run.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.dispatchManualRun(authorization, DispatchManualRunRequestSchema.parse(input)),
  },
  {
    id: "issueEnrollmentToken",
    method: "post",
    path: "/api/v1/daemons/enrollment-tokens",
    legacyPath: "/api/daemons/enrollment-tokens",
    scope: "daemons:enroll",
    successSchema: EnrollmentTokenSchema,
    successStatus: 201,
    resultMapping: "enrollment-token",
    summary: "Issue a daemon enrollment token",
    description: "Returns a short-lived, single-use token for enrolling one daemon.",
    tag: "Daemons",
    responses: {
      201: "A short-lived enrollment token was issued.",
      401: "The API key is missing, malformed, or revoked.",
      403: "The API key lacks daemons:enroll.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization) => operations.issueEnrollmentToken(authorization),
  },
];

export function publicOperation(id: PublicOperationId): PublicOperationDefinition {
  const definition = publicOperationManifest.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`unknown public operation: ${id}`);
  return definition;
}
