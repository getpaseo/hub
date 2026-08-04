import type { ConfigRef } from "./schema.js";
import type { InstanceAuthPolicy } from "../auth/instance-policy.js";
import {
  ConfigInvalid,
  ConfigNotFound,
  ConfigRefMissing,
  ConfigRefUnsupported,
  ConfigUnauthorized,
  createHubConfigResolver as createResolver,
} from "./resolver.js";
import type { ResolveHubConfig, ResolvedHubConfig } from "./resolver.js";
import { createLocalConfigStrategy } from "./strategies/local.js";
export { planWorkspace } from "./workspace.js";
export type { Sidecar, WorkspacePlan, WorkspaceRepoPlan } from "./workspace.js";
export {
  HubConfigSchema,
  ConfigRefSchema,
  WorktreeTargetSchema,
  DEFAULT_TRIGGER_IDLE_TIMEOUT,
  DEFAULT_TRIGGER_TIMEOUT,
  parseTriggerTimeoutMs,
  parseTemplate,
  type MergeTemplateAst,
  type MergeVariableAst,
  type ParsedTemplate,
} from "./schema.js";
export {
  createInterpolationContext,
  interpolateAst,
  interpolateRecord,
  interpolateTemplate,
  interpolateWorktree,
  type ConnectionResolutionContext,
  type ConnectionResolver,
  type InterpolationContext,
} from "./interpolation.js";
export type {
  AgentConfig,
  HubConfig,
  ConfigRef,
  DaemonEnvironment,
  DockerEnvironment,
  EnvironmentConfig,
  FlyEnvironment,
  Trigger,
  TriggerFilter,
  WorktreeTarget,
} from "./schema.js";

export interface RuntimeConfig {
  bind: string;
  databaseUrl: string;
  trustedClientIpHeader?: string;
  authPolicy: InstanceAuthPolicy;
}

export type { ResolveHubConfig, ResolvedHubConfig };
export {
  ConfigInvalid,
  ConfigNotFound,
  ConfigRefMissing,
  ConfigRefUnsupported,
  ConfigUnauthorized,
};

export function createHubConfigResolver(
  options: {
    now?: () => number;
    ttlMs?: number;
  } = {},
): ResolveHubConfig {
  return createResolver({
    strategies: [createLocalConfigStrategy()],
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
  });
}
