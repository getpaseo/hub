import {
  compiledConfigurationHash,
  compileHubConfig,
  parseCompiledHubConfig,
  parseDurationMs,
  rawConfigurationHash,
  WorktreeTargetSchema,
  type AuthoredEnvironment,
  type AuthoredHubConfig,
  type AuthoredInput,
  type AuthoredStep,
  type AuthoredTrigger,
  type AuthoredTriggerFilter,
  type CompiledHubConfig,
  type CompiledInput,
  type CompiledStep,
  type CompiledTrigger,
  type CompiledTriggerFilter,
} from "./compiler.js";
import type { CompiledGitHubAuthority, GitHubPermissionLevel } from "./github-authority.js";

export {
  compiledConfigurationHash,
  compileHubConfig,
  parseCompiledHubConfig,
  parseDurationMs,
  rawConfigurationHash,
  WorktreeTargetSchema,
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type AuthoredAgent = AuthoredStep["agent"];
export type AgentConfig = AuthoredAgent;
export type AllowOutput = NonNullable<AuthoredStep["allow_outputs"]>[number];
export type DaemonEnvironment = Extract<AuthoredEnvironment, { kind: "daemon" }>;
export type FlyEnvironment = Extract<AuthoredEnvironment, { kind: "fly" }>;
export type DockerEnvironment = Extract<AuthoredEnvironment, { kind: "docker" }>;
export type EnvironmentConfig = AuthoredEnvironment;
export type TriggerFilter = CompiledTriggerFilter;
export type Trigger = AuthoredTrigger;
export type HubConfig = AuthoredHubConfig;
export type CompiledConfiguration = CompiledHubConfig;
export type CompiledTriggerConfig = CompiledTrigger;
export type CompiledStepConfig = CompiledStep;
export type { CompiledGitHubAuthority, GitHubPermissionLevel };
export type InputDefinition = AuthoredInput;
export type CompiledInputDefinition = CompiledInput;
export type WorktreeTarget = NonNullable<DaemonEnvironment["worktree"]>;
export type { AuthoredTriggerFilter, CompiledTriggerFilter };
