import { z } from "zod";
import {
  HubConfigSchema,
  compileHubConfig,
  compiledConfigurationHash,
  parseDurationMs,
  parseCompiledHubConfig,
  parseExpression,
  parsePromptText,
  WorktreeTargetSchema,
  type AuthoredEnvironment,
  type AuthoredHubConfig,
  type AuthoredInputDefinition,
  type AuthoredStep,
  type AuthoredTrigger,
  type CompiledHubConfig,
  type CompiledStep,
  type CompiledTrigger,
} from "./compiler.js";

export {
  HubConfigSchema,
  compileHubConfig,
  compiledConfigurationHash,
  parseDurationMs,
  parseCompiledHubConfig,
  parseExpression,
  parsePromptText,
  WorktreeTargetSchema,
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type AuthoredInput = AuthoredInputDefinition;
export type AuthoredAgent = AuthoredStep["agent"];
export type AgentConfig = AuthoredAgent;
export type AllowOutput = NonNullable<AuthoredStep["allow_outputs"]>[number];
export type DaemonEnvironment = Extract<AuthoredEnvironment, { kind: "daemon" }>;
export type FlyEnvironment = Extract<AuthoredEnvironment, { kind: "fly" }>;
export type DockerEnvironment = Extract<AuthoredEnvironment, { kind: "docker" }>;
export type EnvironmentConfig = AuthoredEnvironment;
export type TriggerFilter = NonNullable<AuthoredTrigger["filters"]>;
export type Trigger = AuthoredTrigger;
export type HubConfig = AuthoredHubConfig;
export type CompiledConfiguration = CompiledHubConfig;
export type CompiledTriggerConfig = CompiledTrigger;
export type CompiledStepConfig = CompiledStep;
export type WorktreeTarget = NonNullable<DaemonEnvironment["worktree"]>;

export const ConfigRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("github"), repo: z.string().min(1) }),
  z.object({ type: z.literal("local"), path: z.string().min(1) }),
]);

export type ConfigRef = z.infer<typeof ConfigRefSchema>;
