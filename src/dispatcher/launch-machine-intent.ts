import type { AllowedOutput } from "../execution-capabilities/outputs.js";
import type { TriggerAgentConfig, TriggerProviderMatch } from "../triggers/index.js";
import type { WorktreeTarget } from "../config/index.js";

export interface DaemonEnvironmentTarget {
  kind: "daemon";
  daemonId: string;
  authoredSlug: string;
  cwd: string;
  env?: Record<string, string>;
  worktree?: WorktreeTarget;
}

export interface LaunchMachineIntent {
  kind: "launch_machine";
  organizationId: string;
  projectId: string;
  triggerId: string;
  triggerName: string;
  environmentName: string;
  environment: DaemonEnvironmentTarget;
  prompt: string;
  agent: TriggerAgentConfig;
  allowOutputs: readonly AllowedOutput[];
  timeoutMs?: number;
  idleTimeoutMs?: number;
  autoArchive: boolean;
  triggerContext: unknown;
  outputContext: unknown;
  configurationRevisionId: string;
  hubConfig: unknown;
}

export function buildLaunchMachineIntent(
  input: {
    organizationId: string;
    projectId: string;
    triggerId: string;
    configurationRevisionId: string;
  } & Omit<TriggerProviderMatch, "configurationRevisionId">,
): LaunchMachineIntent {
  return {
    kind: "launch_machine",
    organizationId: input.organizationId,
    projectId: input.projectId,
    triggerId: input.triggerId,
    triggerName: input.triggerName,
    environmentName: input.environmentName,
    environment: input.environment,
    prompt: input.prompt,
    agent: input.agent,
    allowOutputs: input.allowOutputs,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: input.idleTimeoutMs }),
    autoArchive: input.autoArchive,
    triggerContext: input.triggerContext,
    outputContext: input.outputContext,
    configurationRevisionId: input.configurationRevisionId,
    hubConfig: input.hubConfig,
  };
}
