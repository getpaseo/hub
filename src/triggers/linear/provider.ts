import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type { TriggerProvider, TriggerProviderMatch } from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import { NormalizedLinearEventSchema, type NormalizedLinearEvent } from "./events.js";
import { matchLinearTriggers } from "./match.js";

export interface LinearOutputContext {
  provider: "linear";
  linearOrganizationId: string;
  issueId: string;
}

export interface LinearTriggerContext {
  provider: "linear";
  target: LinearOutputContext;
  event: {
    linear: {
      event_type: "issue" | "comment";
      action: "create" | "update" | "remove";
      delivery_id: string;
      connection_id: string | null;
      organization: { id: string };
      actor: { id: string; name?: string | undefined } | null;
      issue: {
        id: string;
        identifier?: string;
        title: string;
        description: string | null;
        url?: string;
        project: { id: string } | null;
        state: { id: string } | null;
        assignee: { id: string } | null;
        label_ids: string[];
      };
      comment: { id: string; body: string } | null;
    };
  };
}

export interface LinearMaterializedContext {
  linear: LinearTriggerContext["event"]["linear"];
}

export function createLinearTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
}): TriggerProvider<
  "linear",
  LinearTriggerContext,
  LinearOutputContext,
  LinearMaterializedContext
> {
  return {
    name: "linear",
    eventNames: ["linear.issue", "linear.comment"],
    async match(externalTrigger) {
      const event = NormalizedLinearEventSchema.parse(externalTrigger.payload);
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (!hasSourceTrigger(stored.configuration.triggers, externalTrigger.source)) {
        return "no_trigger_for_source";
      }
      const matched = matchLinearTriggers(
        stored.configuration,
        event,
        externalTrigger.connectionId,
      );
      if (matched.length === 0) return "trigger_filters_rejected";

      const matches: TriggerProviderMatch<LinearTriggerContext, LinearOutputContext>[] = [];
      for (const candidate of matched) {
        const compiledTrigger = stored.configuration.triggers.find(
          (trigger) => trigger.name === candidate.trigger.name,
        );
        if (compiledTrigger === undefined) {
          throw new Error(`compiled trigger not found: ${candidate.trigger.name}`);
        }
        const issue = event.type === "issue" ? event.issue : event.issue;
        if (issue === null) continue;
        const outputContext: LinearOutputContext = {
          provider: "linear",
          linearOrganizationId: event.organizationId,
          issueId: issue.id,
        };
        const triggerContext: LinearTriggerContext = {
          provider: "linear",
          target: outputContext,
          event: {
            linear: buildLinearContext(
              event,
              externalTrigger.deliveryId,
              externalTrigger.connectionId,
            ),
          },
        };
        const invocation = parseInvocation(
          promptForEvent(event),
          compiledTrigger.inputs,
          undefined,
          promptForEvent(event),
        );
        if (invocation.status === "accepted") {
          if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
          matches.push({
            triggerName: candidate.trigger.name,
            triggerContext,
            outputContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          });
        } else {
          matches.push({
            triggerName: candidate.trigger.name,
            triggerContext,
            outputContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          });
        }
      }
      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },
    async materializeContext(launch) {
      return { linear: launch.triggerContext.event.linear };
    },
  };
}

function hasSourceTrigger(triggers: readonly { on: string }[], source: string): boolean {
  return triggers.some((trigger) =>
    source === "linear.issue"
      ? trigger.on === "linear.issue_entered_scope" || trigger.on === "linear.issue_assigned"
      : source === "linear.comment" && trigger.on === "linear.comment_created",
  );
}

function promptForEvent(event: NormalizedLinearEvent): string {
  if (event.type === "comment") return event.comment.body;
  return event.issue.description === null
    ? event.issue.title
    : `${event.issue.title}\n\n${event.issue.description}`;
}

function buildLinearContext(
  event: NormalizedLinearEvent,
  deliveryId: string,
  connectionId: string | null | undefined,
): LinearTriggerContext["event"]["linear"] {
  const issue = event.type === "issue" ? event.issue : event.issue;
  if (issue === null) throw new Error("Linear event issue context unavailable");
  return {
    event_type: event.type,
    action: event.action,
    delivery_id: deliveryId,
    connection_id: connectionId ?? null,
    organization: { id: event.organizationId },
    actor: event.actor,
    issue: {
      id: issue.id,
      ...(issue.identifier === undefined ? {} : { identifier: issue.identifier }),
      title: issue.title,
      description: issue.description,
      ...(issue.url === undefined ? {} : { url: issue.url }),
      project: issue.projectId === null ? null : { id: issue.projectId },
      state: issue.stateId === null ? null : { id: issue.stateId },
      assignee: issue.assigneeId === null ? null : { id: issue.assigneeId },
      label_ids: issue.labelIds,
    },
    comment: event.type === "comment" ? { id: event.comment.id, body: event.comment.body } : null,
  };
}
