import { z } from "zod";
import type {
  CompiledProjectConfiguration,
  ProjectConfigurationStore,
} from "../../configuration/store.js";
import type { DaemonEnvironmentTarget } from "../../dispatcher/launch-machine-intent.js";
import { cleanTriggerAgent, type TriggerProvider, type TriggerProviderMatch } from "../index.js";
import { interpolateInvocation, matchesInputFilters, parseInvocation } from "../invocation.js";

export const ManualRunPayloadSchema = z.object({
  expectedVersionId: z.string().uuid().optional(),
  trigger: z.string().min(1),
  actor: z.string().min(1),
  input: z.unknown(),
});

export type ManualRunPayload = z.infer<typeof ManualRunPayloadSchema>;
export interface ManualMergeData {
  manual: {
    actor: string;
    input: unknown;
    trigger: string;
    delivery_id: string;
    expected_version_id?: string;
  };
}
export interface ManualRunContext {
  provider: "manual";
  deliveryId: string;
  event: ManualMergeData;
}
export interface ManualRunOutputContext {
  provider: "manual";
  actor: string;
}

export function createManualRunProvider(
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore,
): TriggerProvider<"manual", ManualRunContext, ManualRunOutputContext> {
  return {
    name: "manual",
    eventNames: ["manual.run"],
    async match(external) {
      const store = configurationStoreForProject(external.projectId);
      const payload = ManualRunPayloadSchema.parse(external.payload);
      const stored = await store.getActive();
      if (!stored) {
        throw new Error("manual_config_not_found");
      }
      if (
        payload.expectedVersionId !== undefined &&
        stored.revision.id !== payload.expectedVersionId
      ) {
        throw new Error("expected_config_version_not_current");
      }
      const trigger = stored.configuration.triggers.find(
        (candidate) => candidate.name === payload.trigger && candidate.on === "manual.run",
      );
      if (!trigger) throw new Error("manual_trigger_not_found");
      if (!trigger.filters?.from_users?.includes(payload.actor))
        throw new Error("manual_actor_forbidden");
      const step = trigger.steps[0];
      const event: ManualMergeData = {
        manual: {
          actor: payload.actor,
          input: payload.input,
          trigger: payload.trigger,
          delivery_id: external.deliveryId,
          ...(payload.expectedVersionId === undefined
            ? {}
            : { expected_version_id: payload.expectedVersionId }),
        },
      };
      const triggerContext: ManualRunContext = {
        provider: "manual",
        deliveryId: external.deliveryId,
        event,
      };
      const outputContext: ManualRunOutputContext = { provider: "manual", actor: payload.actor };
      const invocation = parseInvocation(
        typeof payload.input === "string" ? payload.input : "",
        trigger.inputs,
      );
      if (invocation.status === "rejected") {
        return [
          {
            triggerName: trigger.name,
            triggerContext,
            outputContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          },
        ];
      }
      if (invocation.status === "accepted") {
        if (!matchesInputFilters(invocation.inputs, trigger.filters?.inputs)) return [];
      }
      const environmentName = interpolateInvocation(step.environment, invocation);
      const environment = readEnvironment(stored.configuration.environments, environmentName);
      const match: TriggerProviderMatch<ManualRunContext, ManualRunOutputContext> = {
        triggerName: trigger.name,
        stepId: step.id,
        environmentName,
        environment: {
          ...environment,
        },
        prompt: step.prompt.map((block) => block.value).join("\n"),
        agent: cleanTriggerAgent(step.agent),
        allowOutputs: step.allowOutputs,
        timeoutMs: step.maxRuntimeMs,
        runTimeoutMs: trigger.maxRuntimeMs,
        idleTimeoutMs: step.idleTimeoutMs,
        autoArchive: step.autoArchive,
        triggerContext,
        outputContext,
        configurationRevisionId: stored.revision.id,
        hubConfig: stored.configuration,
        invocation,
      };
      return [match];
    },
  };
}

function readEnvironment(
  environments: CompiledProjectConfiguration["environments"],
  name: string,
): DaemonEnvironmentTarget {
  const environment = environments.find((candidate) => candidate.name === name);
  if (!environment || environment.kind !== "daemon")
    throw new Error("manual_environment_not_found");
  return {
    kind: "daemon",
    daemonId: environment.daemonId,
    authoredSlug: environment.daemon,
    cwd: environment.cwd,
    ...(environment.worktree === undefined ? {} : { worktree: environment.worktree }),
  };
}
