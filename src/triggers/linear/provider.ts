import type { TriggerFilter } from "../../config/index.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import {
  LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT,
  type LinearApiClient,
  type LinearIssueComment,
} from "../../providers/linear/client.js";
import { reportFailure } from "../../failures/index.js";
import type { TriggerProvider, TriggerProviderMatch } from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import { NormalizedLinearEventSchema, type NormalizedLinearEvent } from "./events.js";
import {
  matchLinearTriggers,
  readLinearAgentSessionInvocationParserMessage,
  readLinearCommentInvocationParserMessage,
} from "./match.js";
import {
  agentSessionOutputContext,
  buildAgentSessionContext,
  type LinearAgentSessionContext,
  type LinearAgentSessionHooks,
  type LinearAgentSessionOutputContext,
} from "./agent-session.js";

export interface LinearIssueOutputContext {
  provider: "linear";
  linearOrganizationId: string;
  issueId: string;
}

export type LinearOutputContext = LinearIssueOutputContext | LinearAgentSessionOutputContext;

export interface LinearTriggerContext {
  provider: "linear";
  target: LinearOutputContext;
  event: {
    linear: LinearEntityContext | LinearAgentSessionContext;
  };
}

export interface LinearEntityContext {
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
  trigger_thread_context:
    | {
        status: "deferred";
        issue: { id: string };
        before: { created_at: string };
      }
    | { status: "unavailable" };
}

export interface LinearIssueContextMessage {
  id: string;
  content: string;
  author: { id: string; name?: string } | null;
  created_at: string | null;
}

export interface LinearThread {
  status: "available" | "incomplete" | "unavailable";
  messages: LinearIssueContextMessage[];
}

export interface LinearMaterializedContext {
  linear:
    | (Omit<LinearEntityContext, "trigger_thread_context"> & { thread: LinearThread })
    | (LinearAgentSessionContext & { thread: LinearThread });
}

export function createLinearTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  client?: Pick<LinearApiClient, "readIssueComments">;
  agentSessions?: LinearAgentSessionHooks;
}): TriggerProvider<
  "linear",
  LinearTriggerContext,
  LinearOutputContext,
  LinearMaterializedContext
> {
  const sessions = options.agentSessions;
  return {
    name: "linear",
    eventNames: ["linear.issue", "linear.comment", "linear.agent_session"],
    ...(sessions === undefined
      ? {}
      : {
          onDispatchAccepted: async (_triggerContext, outputContext) => {
            await sessions.onDispatchAccepted(outputContext);
          },
          onAgentExecutionStarted: async (_triggerContext, outputContext) => {
            await sessions.onAgentExecutionStarted(outputContext);
          },
          onAgentExecutionCompleted: async (_triggerContext, outputContext, result) => {
            await sessions.onAgentExecutionCompleted(outputContext, result);
          },
          onAgentExecutionFailed: async (_triggerContext, outputContext, reason) => {
            await sessions.onAgentExecutionFailed(outputContext, reason);
          },
          onMachineTerminated: async (triggerContext, reason) => {
            await sessions.onAgentExecutionFailed(triggerContext.target, reason);
          },
        }),
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
        let outputContext: LinearOutputContext;
        let triggerContext: LinearTriggerContext;
        if (event.type === "agent_session") {
          outputContext = agentSessionOutputContext(event);
          triggerContext = {
            provider: "linear",
            target: outputContext,
            event: {
              linear: buildAgentSessionContext(
                event,
                externalTrigger.deliveryId,
                externalTrigger.connectionId,
              ),
            },
          };
        } else {
          const issue = event.issue;
          if (issue === null) continue;
          outputContext = {
            provider: "linear",
            linearOrganizationId: event.organizationId,
            issueId: issue.id,
          };
          triggerContext = {
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
        }
        const prompt = promptForEvent(event);
        const invocation = parseInvocation(
          prompt,
          compiledTrigger.inputs,
          undefined,
          invocationParserMessage(event, compiledTrigger.filters, prompt),
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
    async materializeContext(launch): Promise<LinearMaterializedContext> {
      const source = launch.triggerContext.event.linear;
      if (source.event_type === "agent_session") {
        // Linear already renders issue, discussion, and guidance into one string for the session,
        // so there is nothing to backfill and nothing to truncate.
        return {
          linear: {
            ...source,
            thread:
              source.prompt_context === null
                ? { status: "unavailable", messages: [] }
                : {
                    status: "available",
                    messages: [
                      {
                        id: source.agent_session.id,
                        content: source.prompt_context,
                        author: null,
                        created_at: null,
                      },
                    ],
                  },
          },
        };
      }
      const { trigger_thread_context: locator, ...linear } = source;
      const root = issueRootMessage(linear.issue);
      if (locator.status !== "deferred" || options.client === undefined) {
        return linearThreadContext(linear, "unavailable", [root]);
      }
      try {
        const history = await options.client.readIssueComments({
          linearOrganizationId: linear.organization.id,
          issueId: locator.issue.id,
          beforeCreatedAt: locator.before.created_at,
        });
        const causalComments = history.comments.filter((comment) =>
          isBeforeLinearTrigger(comment, locator.before.created_at),
        );
        const messages = causalComments
          .sort(compareLinearCommentOrder)
          .slice(-LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT)
          .map(commentMessage);
        const complete =
          history.complete &&
          causalComments.length === history.comments.length &&
          causalComments.length <= LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT;
        return linearThreadContext(linear, complete ? "available" : "incomplete", [
          root,
          ...messages,
        ]);
      } catch (error) {
        reportFailure(
          error,
          { operation: "linear.issue.history.hydrate", component: "triggers", provider: "linear" },
          {
            diagnostic: { linearOrganizationId: linear.organization.id, issueId: locator.issue.id },
          },
        );
        return linearThreadContext(linear, "unavailable", [root]);
      }
    },
  };
}

function linearThreadContext(
  linear: Omit<LinearEntityContext, "trigger_thread_context">,
  status: LinearThread["status"],
  messages: LinearIssueContextMessage[],
): LinearMaterializedContext {
  return { linear: { ...linear, thread: { status, messages } } };
}

function issueRootMessage(issue: LinearEntityContext["issue"]): LinearIssueContextMessage {
  return {
    id: issue.id,
    content:
      issue.description === null || issue.description.length === 0
        ? issue.title
        : `${issue.title}\n\n${issue.description}`,
    author: null,
    created_at: null,
  };
}

function commentMessage(comment: LinearIssueComment): LinearIssueContextMessage {
  return {
    id: comment.id,
    content: comment.body,
    author: comment.author,
    created_at: comment.createdAt,
  };
}

function isBeforeLinearTrigger(comment: LinearIssueComment, beforeCreatedAt: string): boolean {
  const commentAt = Date.parse(comment.createdAt);
  const triggerAt = Date.parse(beforeCreatedAt);
  return Number.isFinite(commentAt) && Number.isFinite(triggerAt) && commentAt < triggerAt;
}

function compareLinearCommentOrder(left: LinearIssueComment, right: LinearIssueComment): number {
  const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
}

function hasSourceTrigger(triggers: readonly { on: string }[], source: string): boolean {
  return triggers.some((trigger) => {
    if (source === "linear.issue") {
      return trigger.on === "linear.issue_entered_scope" || trigger.on === "linear.issue_assigned";
    }
    if (source === "linear.comment") return trigger.on === "linear.comment_created";
    return source === "linear.agent_session" && trigger.on === "linear.agent_session";
  });
}

function invocationParserMessage(
  event: NormalizedLinearEvent,
  filters: TriggerFilter | undefined,
  prompt: string,
): string {
  if (event.type === "comment") return readLinearCommentInvocationParserMessage(event, filters);
  if (event.type === "agent_session") {
    return readLinearAgentSessionInvocationParserMessage(event.prompt);
  }
  return prompt;
}

function promptForEvent(event: NormalizedLinearEvent): string {
  if (event.type === "comment") return event.comment.body;
  // The session prompt is what the human typed, so `agent=` style inputs parse exactly as in a
  // comment. Linear's rendered context is passed separately through `${{ paseo.context }}`.
  if (event.type === "agent_session") return event.prompt;
  return event.issue.description === null
    ? event.issue.title
    : `${event.issue.title}\n\n${event.issue.description}`;
}

function buildLinearContext(
  event: Exclude<NormalizedLinearEvent, { type: "agent_session" }>,
  deliveryId: string,
  connectionId: string | null | undefined,
): LinearEntityContext {
  const issue = event.issue;
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
    trigger_thread_context:
      event.occurredAt === undefined
        ? { status: "unavailable" }
        : {
            status: "deferred",
            issue: { id: issue.id },
            before: { created_at: event.occurredAt },
          },
  };
}
