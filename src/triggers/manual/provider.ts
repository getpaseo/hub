import { z } from "zod";
import {
  interpolateRecord,
  interpolateTemplate,
  createInterpolationContext,
  parseTriggerTimeoutMs,
} from "../../config/index.js";
import type {
  CompiledProjectConfiguration,
  ProjectConfigurationStore,
} from "../../configuration/store.js";
import type { DaemonEnvironmentTarget } from "../../dispatcher/launch-machine-intent.js";
import { cleanTriggerAgent, type TriggerProvider, type TriggerProviderMatch } from "../index.js";

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
      const environment = readEnvironment(stored.configuration.environments, trigger.environment);
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
      const context = createInterpolationContext(event);
      const [prompt, env] = await Promise.all([
        interpolateTemplate(trigger.prompt, context),
        interpolateRecord(trigger.env, context),
      ]);
      const match: TriggerProviderMatch<ManualRunContext, ManualRunOutputContext> = {
        triggerName: trigger.name,
        environmentName: trigger.environment,
        environment: {
          ...environment,
          ...(Object.keys(env).length === 0 ? {} : { env }),
        },
        prompt,
        agent: cleanTriggerAgent(trigger.agent),
        allowOutputs: trigger.allow_outputs ?? [],
        timeoutMs: parseTriggerTimeoutMs(trigger.timeout),
        idleTimeoutMs: parseTriggerTimeoutMs(trigger.idle_timeout),
        autoArchive: trigger.auto_archive,
        triggerContext: {
          provider: "manual",
          deliveryId: external.deliveryId,
          event,
        },
        outputContext: { provider: "manual", actor: payload.actor },
        configurationRevisionId: stored.revision.id,
        hubConfig: stored.configuration,
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
