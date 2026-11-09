import type { InstanceAuthPolicy } from "../auth/instance-policy.js";

export {
  compiledConfigurationHash,
  compileHubConfig,
  parseCompiledHubConfig,
  parseDurationMs,
  rawConfigurationHash,
  WorktreeTargetSchema,
} from "./schema.js";
export type {
  AgentConfig,
  AuthoredTriggerFilter,
  CompiledConfiguration,
  CompiledStepConfig,
  CompiledTriggerConfig,
  CompiledTriggerFilter,
  DaemonEnvironment,
  DockerEnvironment,
  EnvironmentConfig,
  FlyEnvironment,
  HubConfig,
  Trigger,
  TriggerFilter,
  WorktreeTarget,
} from "./schema.js";

export interface RuntimeConfig {
  bind: string;
  trustedClientIpHeader?: string;
  authPolicy: InstanceAuthPolicy;
}
