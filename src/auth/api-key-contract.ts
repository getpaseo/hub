import { z } from "zod";

export const API_KEY_SCOPES = ["configuration:install", "runs:dispatch", "daemons:enroll"] as const;

export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);
export const apiKeyScopesSchema = z.array(apiKeyScopeSchema).min(1).max(API_KEY_SCOPES.length);

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
