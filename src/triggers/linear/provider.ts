import type { CompiledTriggerConfig } from "../../config/index.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type { Database, LinearConnectionRecord } from "../../db/types.js";
import {
  LINEAR_STOPPED_BY_USER_REASON,
  LINEAR_SUPERSEDED_BY_AGENT_SESSION_REASON,
} from "../../db/linear-trigger-suppression.js";
import {
  LINEAR_AGENT_ACTIVITY_CONTEXT_LIMIT,
  LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT,
  type LinearApiClient,
  type LinearAgentActivity,
  type LinearIssueComment,
} from "../../providers/linear/client.js";
import { OUTPUT_DELIVERY_FAILED_REASON } from "../../execution-capabilities/required-outputs.js";
import { reportFailure } from "../../failures/index.js";
import { logger } from "../../logger.js";
import type { TriggerProviderExecutionControl } from "../../providers/registration.js";
import type {
  ExternalTrigger,
  TriggerProvider,
  TriggerProviderMatch,
  TriggerProviderReactionState,
} from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import {
  NormalizedLinearEventSchema,
  type NormalizedLinearAgentSessionEvent,
  type NormalizedLinearEvent,
} from "./events.js";
import {
  matchLinearTriggers,
  readLinearAgentSessionInvocationParserMessage,
  readLinearCommentInvocationParserMessage,
} from "./match.js";
import { LINEAR_REPLY_OUTPUT_TYPE } from "./reply.js";

export interface LinearOutputContext {
  provider: "linear";
  linearOrganizationId: string;
  issueId: string;
  agentSessionId: string | null;
  /**
   * Linear threads are one level deep: a reply's parent must be the top-level comment, and
   * Linear rejects a nested comment as parent. Null when the trigger was not a comment.
   */
  threadRootCommentId: string | null;
}

export interface LinearTriggerContext {
  provider: "linear";
  target: LinearOutputContext;
  event: {
    linear: {
      event_type: "issue" | "comment" | "agent_session";
      action: "create" | "update" | "remove" | "created" | "prompted";
      occurred_at: string | null;
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
        signal?: "stop";
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

export { LINEAR_STOPPED_BY_USER_REASON, LINEAR_SUPERSEDED_BY_AGENT_SESSION_REASON };

export interface LinearTriggerProviderOptions {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  client?: Pick<
    LinearApiClient,
    "readIssueComments" | "readAgentSessionActivities" | "readCommentThread" | "createAgentActivity"
  >;
  /** The connection bound to a Linear workspace; its app user is what `thread_with_app` looks for. */
  connectionForLinearOrganization?: (input: {
    organizationId: string;
    linearOrganizationId: string;
  }) => Promise<Pick<LinearConnectionRecord, "appUserId"> | undefined>;
  /** Receipt/run reads used to deduplicate session side effects. */
  database?: Pick<Database, "findProviderEventReceiptById" | "listTriggerRunsForLinearComments"> &
    Partial<Pick<Database, "recordLinearTriggerSuppressions">>;
  executions?: TriggerProviderExecutionControl;
}

export function createLinearTriggerProvider(
  options: LinearTriggerProviderOptions,
): TriggerProvider<"linear", LinearTriggerContext, LinearOutputContext, LinearMaterializedContext> {
  return {
    name: "linear",
    eventNames: ["linear.issue", "linear.comment", "linear.agent_session"],
    async match(externalTrigger) {
      const received = NormalizedLinearEventSchema.parse(externalTrigger.payload);
      if (received.type === "agent_session" && received.agentActivity?.signal === "stop") {
        await stopLinearAgentSession(options, externalTrigger, received);
        return "agent_session_stopped";
      }
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (!hasSourceTrigger(stored.configuration.triggers, externalTrigger.source)) {
        return "no_trigger_for_source";
      }
      const { event, appUserId } = await hydrateLinearCommentThread(
        options,
        externalTrigger,
        received,
        stored.configuration.triggers,
      );
      const matched = matchLinearTriggers(
        stored.configuration,
        event,
        externalTrigger.connectionId,
        appUserId,
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
          threadRootCommentId:
            event.type === "comment" ? (event.comment.parentId ?? event.comment.id) : null,
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
      if (matches.length === 0) return "trigger_filters_rejected";
      if (event.type === "agent_session" && event.action === "created") {
        await supersedeLinearCommentRuns(options, externalTrigger, event);
      }
      return matches;
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
    async onAgentExecutionCompleted(triggerContext, _outputContext, result, reactionState) {
      const agentSession = triggerContext.event.linear.agent_session;
      if (agentSession === null || options.client === undefined) return reactionState;
      if (linearAgentReactionPhase(reactionState) === "completed") return reactionState;
      // Linear keeps the session `active` (then `stale`) until a response or error
      // lands. A reply already closed it; otherwise close it explicitly. Unknown
      // emissions are left alone rather than risking a false "no reply" notice.
      if (
        result.outputEmissions !== undefined &&
        (result.outputEmissions[LINEAR_REPLY_OUTPUT_TYPE] ?? 0) === 0
      ) {
        await options.client.createAgentActivity({
          linearOrganizationId: triggerContext.event.linear.organization.id,
          agentSessionId: agentSession.id,
          content: {
            type: "response",
            body: "Paseo finished this workflow without posting a reply.",
          },
        });
      }
      return { phase: "completed" };
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
    occurred_at: event.occurredAt ?? null,
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
            ...(event.agentActivity.signal === undefined
              ? {}
              : { signal: event.agentActivity.signal }),
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

/**
 * `thread_with_app` needs two things the webhook does not carry: who wrote in the thread, and
 * which Linear user the connection acts as. Both are read only when a configured trigger asks
 * for them, and a failed read leaves the event as delivered so the filter fails closed while
 * every other trigger still dispatches.
 */
async function hydrateLinearCommentThread(
  options: Pick<LinearTriggerProviderOptions, "client" | "connectionForLinearOrganization">,
  externalTrigger: ExternalTrigger,
  event: NormalizedLinearEvent,
  triggers: readonly Pick<CompiledTriggerConfig, "on" | "filters">[],
): Promise<{ event: NormalizedLinearEvent; appUserId: string | undefined }> {
  if (
    event.type !== "comment" ||
    event.action !== "create" ||
    event.comment.parentId === null ||
    !triggers.some(
      (trigger) =>
        trigger.on === "linear.comment_created" && trigger.filters?.thread_with_app === true,
    )
  ) {
    return { event, appUserId: undefined };
  }
  const diagnostic = { linearOrganizationId: event.organizationId, commentId: event.comment.id };
  let appUserId: string | undefined;
  try {
    const connection = await options.connectionForLinearOrganization?.({
      organizationId: externalTrigger.organizationId,
      linearOrganizationId: event.organizationId,
    });
    appUserId = connection?.appUserId;
  } catch (error) {
    logger.warn(
      { err: error, ...diagnostic },
      "Linear connection lookup failed; thread_with_app triggers will not match",
    );
  }
  if (appUserId === undefined || event.threadAuthorIds !== undefined) return { event, appUserId };
  try {
    const thread = await options.client?.readCommentThread(diagnostic);
    return {
      event: thread === undefined ? event : { ...event, threadAuthorIds: thread.authorIds },
      appUserId,
    };
  } catch (error) {
    logger.warn(
      { err: error, ...diagnostic },
      "Linear comment thread read failed; thread_with_app triggers will not match",
    );
    return { event, appUserId };
  }
}

/**
 * A mention that opens an agent session also arrives as a comment, moments earlier. When a
 * comment trigger already started a run from that comment, the session is the canonical
 * handling: the comment run is stopped so the user is not answered twice. The mention may sit
 * in a reply, so the comment that created the session is checked as well as the thread's root.
 * The association is persisted before the scan so a delayed comment run cannot start afterward;
 * a failure while stopping already-running work is reported but does not hold back the session.
 */
async function supersedeLinearCommentRuns(
  options: Pick<LinearTriggerProviderOptions, "database" | "executions">,
  trigger: Pick<ExternalTrigger, "organizationId" | "projectId" | "providerEventReceiptId">,
  event: NormalizedLinearAgentSessionEvent,
): Promise<void> {
  const projectId = trigger.projectId;
  const commentIds = [
    ...new Set(
      [event.agentSession.rootCommentId, event.agentSession.sourceCommentId].filter(
        (id): id is string => id !== undefined,
      ),
    ),
  ];
  if (commentIds.length === 0) return;
  await options.database?.recordLinearTriggerSuppressions?.({
    organizationId: trigger.organizationId,
    projectId,
    providerEventReceiptId: trigger.providerEventReceiptId,
    reason: LINEAR_SUPERSEDED_BY_AGENT_SESSION_REASON,
    externalIds: commentIds,
    eventOccurredAt: new Date(event.occurredAt),
  });
  if (options.database === undefined || options.executions === undefined) return;
  try {
    const superseded = new Set(
      (await options.database.listTriggerRunsForLinearComments(projectId, commentIds)).map(
        (run) => run.id,
      ),
    );
    if (superseded.size === 0) return;
    await options.executions.stopActive({
      projectId,
      reason: LINEAR_SUPERSEDED_BY_AGENT_SESSION_REASON,
      matches: (work) => work.triggerRunId !== null && superseded.has(work.triggerRunId),
    });
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "linear.agent-session.supersede-comment-runs",
        component: "triggers",
        provider: "linear",
      },
      { diagnostic: { projectId, agentSessionId: event.agentSession.id, commentIds } },
    );
  }
}

function linearAgentReactionPhase(
  reactionState: TriggerProviderReactionState | undefined,
): "accepted" | "completed" | "failed" | undefined {
  if (typeof reactionState !== "object" || reactionState === null || Array.isArray(reactionState)) {
    return undefined;
  }
  const phase = reactionState["phase"];
  return phase === "accepted" || phase === "completed" || phase === "failed" ? phase : undefined;
}

/**
 * Linear's `stop` signal arrives as a prompt; it must not start a run. The session's pending
 * executions and not-yet-dispatched runs are failed with a dedicated reason (so no error is
 * posted for them). The stop is persisted before that scan so an older delivery cannot launch
 * afterward, and Linear receives the `response` it expects to settle the session.
 */
async function stopLinearAgentSession(
  options: {
    client?: Pick<LinearApiClient, "createAgentActivity">;
    database?: Pick<Database, "findProviderEventReceiptById"> &
      Partial<Pick<Database, "recordLinearTriggerSuppressions">>;
    executions?: TriggerProviderExecutionControl;
  },
  trigger: Pick<ExternalTrigger, "organizationId" | "projectId" | "providerEventReceiptId">,
  event: NormalizedLinearAgentSessionEvent,
): Promise<void> {
  const agentSessionId = event.agentSession.id;
  await options.database?.recordLinearTriggerSuppressions?.({
    organizationId: trigger.organizationId,
    projectId: trigger.projectId,
    providerEventReceiptId: trigger.providerEventReceiptId,
    reason: LINEAR_STOPPED_BY_USER_REASON,
    externalIds: [agentSessionId],
    eventOccurredAt: new Date(event.occurredAt),
  });
  await options.executions?.stopActive({
    projectId: trigger.projectId,
    reason: LINEAR_STOPPED_BY_USER_REASON,
    matches: (execution) => readLinearAgentSessionId(execution.outputContext) === agentSessionId,
  });
  if (!(await isLinearStopConfirmationRoute(options.database, trigger))) return;
  await options.client?.createAgentActivity({
    linearOrganizationId: event.organizationId,
    agentSessionId,
    content: { type: "response", body: "Stopped at your request." },
  });
}

/** The receipt snapshot gives one route ownership of the shared Linear confirmation. */
async function isLinearStopConfirmationRoute(
  database: Pick<Database, "findProviderEventReceiptById"> | undefined,
  trigger: Pick<ExternalTrigger, "projectId" | "providerEventReceiptId">,
): Promise<boolean> {
  if (database === undefined) return true;
  const receipt = await database.findProviderEventReceiptById(trigger.providerEventReceiptId);
  const confirmationRoute = receipt?.acceptedRoutes?.[0];
  if (confirmationRoute === undefined) throw new Error("Linear stop receipt route unavailable");
  return confirmationRoute.projectId === trigger.projectId;
}

function readLinearAgentSessionId(outputContext: unknown): string | null {
  if (typeof outputContext !== "object" || outputContext === null) return null;
  const context = outputContext as Partial<LinearOutputContext>;
  if (context.provider !== "linear") return null;
  return typeof context.agentSessionId === "string" ? context.agentSessionId : null;
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
  // The stop handler already confirmed the stop; an error would contradict it.
  if (reason === LINEAR_STOPPED_BY_USER_REASON) return { phase: "failed" };
  await client.createAgentActivity({
    linearOrganizationId: triggerContext.event.linear.organization.id,
    agentSessionId: agentSession.id,
    content: { type: "error", body: linearFailureBody(reason) },
  });
  return { phase: "failed" };
}

function linearFailureBody(reason: string): string {
  // The reply itself is what failed; the internal reason would not help the user.
  if (reason === OUTPUT_DELIVERY_FAILED_REASON) {
    return "Paseo could not deliver its reply to this session.";
  }
  return `Paseo could not complete this workflow: ${reason.slice(0, 1_000)}`;
}
