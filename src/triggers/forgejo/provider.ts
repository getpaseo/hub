import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type { TriggerProvider, TriggerProviderMatch } from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import {
  FORGEJO_TRIGGER_EVENT_NAMES,
  normalizeForgejoReceiptPayload,
  type ForgejoConnectionContext,
  type NormalizedForgejoEvent,
} from "./normalize.js";
import {
  matchForgejoTriggers,
  readForgejoInvocationMessage,
  readForgejoInvocationParserMessage,
  readForgejoMention,
} from "./matching.js";

export interface ForgejoTriggerContext {
  provider: "forgejo";
  target: { connectionId: string; repositoryId: number; repository: string };
  event: ForgejoMergeData;
}

export interface ForgejoMergeData {
  forgejo: {
    delivery_id: string;
    event_name: string;
    repository: { full_name: string; id: number };
    actor: { id: number; login: string };
    received_at: string;
    identity: { eventId: string };
  };
}

export function createForgejoTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  connectionFor?: (connectionId: string) => Promise<ForgejoConnectionContext | undefined>;
}): TriggerProvider<"forgejo", ForgejoTriggerContext> {
  return {
    name: "forgejo",
    eventNames: [...FORGEJO_TRIGGER_EVENT_NAMES],
    async match(externalTrigger) {
      const connectionId = externalTrigger.connectionId;
      if (connectionId === undefined || connectionId === null) return "no_trigger_for_source";
      const connection =
        options.connectionFor === undefined
          ? fallbackConnection(connectionId)
          : await options.connectionFor(connectionId);
      if (connection === undefined) return "configuration_unavailable";
      const normalized = normalizeForgejoReceiptPayload({
        payload: externalTrigger.payload,
        connection,
      });
      if (normalized.kind !== "event") return "no_trigger_for_source";
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      const event = normalized.event;
      if (
        !stored.configuration.triggers.some((candidate) =>
          [event.receiptSource, event.rawFamily, event.semanticEvent].includes(candidate.on),
        )
      ) {
        return "no_trigger_for_source";
      }
      const matches: TriggerProviderMatch<ForgejoTriggerContext>[] = [];
      for (const match of matchForgejoTriggers(
        stored.configuration,
        event,
        externalTrigger.connectionId,
      )) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiledTrigger === undefined) {
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
        }
        const triggerContext = forgejoTriggerContext(event, externalTrigger.receivedAt);
        const invocation = parseInvocation(
          readForgejoInvocationMessage(event),
          compiledTrigger.inputs,
          readForgejoMention(event, compiledTrigger.filters),
          readForgejoInvocationParserMessage(event, compiledTrigger.filters),
        );
        if (invocation.status === "accepted") {
          if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
        }
        if (invocation.status === "rejected") {
          matches.push({
            triggerName: match.trigger.name,
            triggerContext,
            outputContext: triggerContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          });
          continue;
        }
        matches.push({
          triggerName: match.trigger.name,
          triggerContext,
          outputContext: triggerContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
          invocation,
        });
      }
      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },
    async materializeContext(launch) {
      return launch.triggerContext.event;
    },
  };
}

function forgejoTriggerContext(
  event: NormalizedForgejoEvent,
  receivedAt: Date,
): ForgejoTriggerContext {
  return {
    provider: "forgejo",
    target: {
      connectionId: event.context.connectionId,
      repositoryId: event.context.repository.id,
      repository: event.context.repository.full_name,
    },
    event: {
      forgejo: {
        delivery_id: event.context.deliveryId,
        event_name: event.rawFamily,
        repository: {
          full_name: event.context.repository.full_name,
          id: event.context.repository.id,
        },
        actor: event.context.actor,
        received_at: receivedAt.toISOString(),
        identity: event.identity,
      },
    },
  };
}

function fallbackConnection(connectionId: string): ForgejoConnectionContext {
  return { id: connectionId, slug: connectionId, instanceId: connectionId };
}
