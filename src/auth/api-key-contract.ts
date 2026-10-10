import { z } from "zod";

export const CLI_OPERATION_SCOPES = [
  "projects:read",
  "configuration:validate",
  "configuration:install",
  "runs:dispatch",
  "daemons:enroll",
] as const;

export const API_KEY_SCOPES = [...CLI_OPERATION_SCOPES, "agents:read", "agents:control"] as const;

export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);
export const apiKeyScopesSchema = z.array(apiKeyScopeSchema).min(1).max(API_KEY_SCOPES.length);

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
