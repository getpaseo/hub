import type { ProjectConfigurationStore } from "../../configuration/store.js";
import {
  LINEAR_AGENT_ACTIVITY_CONTEXT_LIMIT,
  LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT,
  type LinearApiClient,
  type LinearAgentActivity,
  type LinearIssueComment,
} from "../../providers/linear/client.js";
import { reportFailure } from "../../failures/index.js";
import type {
  TriggerProvider,
  TriggerProviderMatch,
  TriggerProviderReactionState,
} from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import { NormalizedLinearEventSchema, type NormalizedLinearEvent } from "./events.js";
import {
  matchLinearTriggers,
  readLinearAgentSessionInvocationParserMessage,
  readLinearCommentInvocationParserMessage,
} from "./match.js";

export interface LinearOutputContext {
  provider: "linear";
  linearOrganizationId: string;
  issueId: string;
  agentSessionId: string | null;
}

export interface LinearTriggerContext {
  provider: "linear";
  target: LinearOutputContext;
  event: {
    linear: {
      event_type: "issue" | "comment" | "agent_session";
      action: "create" | "update" | "remove" | "created" | "prompted";
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
        team: { id: string } | null;
        state: { id: string } | null;
        assignee: { id: string } | null;
        label_ids: string[];
      };
      comment: { id: string; body: string; parent_id: string | null } | null;
      agent_session: {
        id: string;
        app_user_id: string;
        status: string;
        url?: string;
      } | null;
      agent_activity: {
        id: string;
        type: "prompt";
        body: string;
        created_at: string;
      } | null;
      prompt_context: string | null;
      trigger_thread_context:
        | {
            status: "deferred";
            issue: { id: string };
            before: { created_at: string };
          }
        | {
            status: "deferred";
            agent_session: { id: string };
            before: { created_at: string };
          }
        | { status: "embedded" }
        | { status: "unavailable" };
    };
  };
}

export interface LinearIssueContextMessage {
  id: string;
  content: string;
  author: { id: string; name?: string } | null;
  created_at: string | null;
}

export interface LinearMaterializedContext {
  linear: Omit<LinearTriggerContext["event"]["linear"], "trigger_thread_context"> & {
    thread: {
      status: "available" | "incomplete" | "unavailable";
      messages: LinearIssueContextMessage[];
    };
  };
}

export function createLinearTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  client?: Pick<
    LinearApiClient,
    "readIssueComments" | "readAgentSessionActivities" | "createAgentActivity"
  >;
}): TriggerProvider<
  "linear",
  LinearTriggerContext,
  LinearOutputContext,
  LinearMaterializedContext
> {
  return {
    name: "linear",
    eventNames: ["linear.issue", "linear.comment", "linear.agent_session"],
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
          agentSessionId: event.type === "agent_session" ? event.agentSession.id : null,
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
        const prompt = promptForEvent(event);
        const invocation = parseInvocation(
          prompt,
          compiledTrigger.inputs,
          undefined,
          parserMessageForEvent(event, compiledTrigger.filters),
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
      const { trigger_thread_context: locator, ...linear } = launch.triggerContext.event.linear;
      const root = issueRootMessage(linear.issue);
      if (locator.status === "embedded") {
        return linearThreadContext(linear, "available", [root]);
      }
      if (locator.status !== "deferred" || options.client === undefined) {
        return linearThreadContext(linear, "unavailable", [root]);
      }
      if ("agent_session" in locator) {
        try {
          const history = await options.client.readAgentSessionActivities({
            linearOrganizationId: linear.organization.id,
            agentSessionId: locator.agent_session.id,
            beforeCreatedAt: locator.before.created_at,
          });
          const causalActivities = history.activities.filter((activity) =>
            isBeforeLinearActivity(activity, locator.before.created_at),
          );
          const messages = causalActivities
            .sort(compareLinearActivityOrder)
            .slice(-LINEAR_AGENT_ACTIVITY_CONTEXT_LIMIT)
            .map(activityMessage);
          const complete =
            history.complete &&
            causalActivities.length === history.activities.length &&
            causalActivities.length <= LINEAR_AGENT_ACTIVITY_CONTEXT_LIMIT;
          return linearThreadContext(linear, complete ? "available" : "incomplete", [
            root,
            ...messages,
          ]);
        } catch (error) {
          reportFailure(
            error,
            {
              operation: "linear.agent-session.history.hydrate",
              component: "triggers",
              provider: "linear",
            },
            {
              diagnostic: {
                linearOrganizationId: linear.organization.id,
                agentSessionId: locator.agent_session.id,
              },
            },
          );
          return linearThreadContext(linear, "unavailable", [root]);
        }
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
    async onDispatchAccepted(triggerContext, _outputContext, reactionState) {
      const agentSession = triggerContext.event.linear.agent_session;
      if (agentSession === null || options.client === undefined) return reactionState;
      if (linearAgentReactionPhase(reactionState) !== undefined) return reactionState;
      await options.client.createAgentActivity({
        linearOrganizationId: triggerContext.event.linear.organization.id,
        agentSessionId: agentSession.id,
        content: {
          type: "thought",
          body: "Paseo accepted this task and is starting the workflow.",
        },
        ephemeral: true,
      });
      return { phase: "accepted" };
    },
    async onAgentExecutionFailed(triggerContext, _outputContext, reason, reactionState) {
      return notifyLinearAgentFailure(options.client, triggerContext, reason, reactionState);
    },
    async onMachineTerminated(triggerContext, reason, reactionState) {
      return notifyLinearAgentFailure(options.client, triggerContext, reason, reactionState);
    },
  };
}

function linearThreadContext(
  linear: Omit<LinearTriggerContext["event"]["linear"], "trigger_thread_context">,
  status: LinearMaterializedContext["linear"]["thread"]["status"],
  messages: LinearIssueContextMessage[],
): LinearMaterializedContext {
  return { linear: { ...linear, thread: { status, messages } } };
}

function issueRootMessage(
  issue: LinearTriggerContext["event"]["linear"]["issue"],
): LinearIssueContextMessage {
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

function activityMessage(activity: LinearAgentActivity): LinearIssueContextMessage {
  return {
    id: activity.id,
    content: activity.body,
    author: activity.author,
    created_at: activity.createdAt,
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

function isBeforeLinearActivity(activity: LinearAgentActivity, beforeCreatedAt: string): boolean {
  const activityAt = Date.parse(activity.createdAt);
  const triggerAt = Date.parse(beforeCreatedAt);
  return Number.isFinite(activityAt) && Number.isFinite(triggerAt) && activityAt < triggerAt;
}

function compareLinearActivityOrder(left: LinearAgentActivity, right: LinearAgentActivity): number {
  const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
}

function hasSourceTrigger(triggers: readonly { on: string }[], source: string): boolean {
  return triggers.some((trigger) => triggerMatchesLinearSource(trigger.on, source));
}

function triggerMatchesLinearSource(trigger: string, source: string): boolean {
  if (source === "linear.issue") {
    return trigger === "linear.issue_entered_scope" || trigger === "linear.issue_assigned";
  }
  if (source === "linear.comment") return trigger === "linear.comment_created";
  return source === "linear.agent_session" && trigger === "linear.agent_session";
}

function promptForEvent(event: NormalizedLinearEvent): string {
  if (event.type === "comment") return event.comment.body;
  if (event.type === "agent_session") return event.prompt;
  return event.issue.description === null
    ? event.issue.title
    : `${event.issue.title}\n\n${event.issue.description}`;
}

function parserMessageForEvent(
  event: NormalizedLinearEvent,
  filters: Parameters<typeof readLinearCommentInvocationParserMessage>[1],
): string {
  if (event.type === "comment") return readLinearCommentInvocationParserMessage(event, filters);
  if (event.type === "agent_session") {
    return readLinearAgentSessionInvocationParserMessage(event, filters);
  }
  return promptForEvent(event);
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
      team: issue.teamId === null ? null : { id: issue.teamId },
      state: issue.stateId === null ? null : { id: issue.stateId },
      assignee: issue.assigneeId === null ? null : { id: issue.assigneeId },
      label_ids: issue.labelIds,
    },
    comment:
      event.type === "comment"
        ? {
            id: event.comment.id,
            body: event.comment.body,
            parent_id: event.comment.parentId,
          }
        : null,
    agent_session:
      event.type === "agent_session"
        ? {
            id: event.agentSession.id,
            app_user_id: event.agentSession.appUserId,
            status: event.agentSession.status,
            ...(event.agentSession.url === undefined ? {} : { url: event.agentSession.url }),
          }
        : null,
    agent_activity:
      event.type === "agent_session" && event.agentActivity !== null
        ? {
            id: event.agentActivity.id,
            type: event.agentActivity.type,
            body: event.agentActivity.body,
            created_at: event.agentActivity.createdAt,
          }
        : null,
    prompt_context: event.type === "agent_session" ? event.promptContext : null,
    trigger_thread_context: linearThreadContextLocator(event, issue.id),
  };
}

function linearThreadContextLocator(
  event: NormalizedLinearEvent,
  issueId: string,
): LinearTriggerContext["event"]["linear"]["trigger_thread_context"] {
  if (event.type === "agent_session") {
    if (event.action === "created") return { status: "embedded" };
    return {
      status: "deferred",
      agent_session: { id: event.agentSession.id },
      before: { created_at: event.occurredAt },
    };
  }
  if (event.occurredAt === undefined) return { status: "unavailable" };
  return {
    status: "deferred",
    issue: { id: issueId },
    before: { created_at: event.occurredAt },
  };
}

function linearAgentReactionPhase(
  reactionState: TriggerProviderReactionState | undefined,
): "accepted" | "failed" | undefined {
  if (typeof reactionState !== "object" || reactionState === null || Array.isArray(reactionState)) {
    return undefined;
  }
  const phase = reactionState["phase"];
  return phase === "accepted" || phase === "failed" ? phase : undefined;
}

async function notifyLinearAgentFailure(
  client: Pick<LinearApiClient, "createAgentActivity"> | undefined,
  triggerContext: LinearTriggerContext,
  reason: string,
  reactionState: TriggerProviderReactionState | undefined,
): Promise<TriggerProviderReactionState | undefined> {
  const agentSession = triggerContext.event.linear.agent_session;
  if (agentSession === null || client === undefined) return reactionState;
  if (linearAgentReactionPhase(reactionState) === "failed") return reactionState;
  await client.createAgentActivity({
    linearOrganizationId: triggerContext.event.linear.organization.id,
    agentSessionId: agentSession.id,
    content: {
      type: "error",
      body: `Paseo could not complete this workflow: ${reason.slice(0, 1_000)}`,
    },
  });
  return { phase: "failed" };
}
