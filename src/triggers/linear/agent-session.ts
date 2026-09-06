import { reportFailure } from "../../failures/index.js";
import type { LinearAgentActivityContent, LinearApiClient } from "../../providers/linear/client.js";
import type { TriggerProviderLifecycleResult } from "../index.js";
import type { NormalizedLinearAgentSessionEvent } from "./events.js";

/** How much of a failure reason is worth putting in front of a human inside the issue. */
const MAX_ERROR_BODY = 600;

export interface LinearAgentSessionOutputContext {
  provider: "linear";
  linearOrganizationId: string;
  issueId: string | null;
  agentSessionId: string;
}

export interface LinearAgentSessionContext {
  event_type: "agent_session";
  action: "created" | "prompted";
  delivery_id: string;
  connection_id: string | null;
  organization: { id: string };
  actor: { id: string; name?: string | undefined } | null;
  agent_session: { id: string; status?: string | undefined; comment_id: string | null };
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
  } | null;
  prompt_context: string | null;
}

export function agentSessionOutputContext(
  event: NormalizedLinearAgentSessionEvent,
): LinearAgentSessionOutputContext {
  return {
    provider: "linear",
    linearOrganizationId: event.organizationId,
    issueId: event.issue?.id ?? null,
    agentSessionId: event.agentSession.id,
  };
}

export function buildAgentSessionContext(
  event: NormalizedLinearAgentSessionEvent,
  deliveryId: string,
  connectionId: string | null | undefined,
): LinearAgentSessionContext {
  const issue = event.issue;
  return {
    event_type: "agent_session",
    action: event.action,
    delivery_id: deliveryId,
    connection_id: connectionId ?? null,
    organization: { id: event.organizationId },
    actor: event.actor,
    agent_session: {
      id: event.agentSession.id,
      ...(event.agentSession.status === undefined ? {} : { status: event.agentSession.status }),
      comment_id: event.agentSession.commentId,
    },
    issue:
      issue === null
        ? null
        : {
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
    prompt_context: event.promptContext,
  };
}

function isAgentSessionOutputContext(value: unknown): value is LinearAgentSessionOutputContext {
  if (typeof value !== "object" || value === null) return false;
  return (
    Reflect.get(value, "provider") === "linear" &&
    typeof Reflect.get(value, "agentSessionId") === "string"
  );
}

/**
 * Linear ends a session when it sees a `response`, so exactly one has to arrive. The agent's own
 * reply is the good one; this remembers whether it came so the terminal hook only fills a gap
 * instead of talking over it. In-memory is deliberate: a restart mid-run costs at most one
 * duplicate closing line, which is cheaper than a schema migration for transient state.
 */
export class LinearAgentSessionTracker {
  private readonly responded = new Set<string>();

  markResponded(agentSessionId: string): void {
    this.responded.add(agentSessionId);
  }

  hasResponded(agentSessionId: string): boolean {
    return this.responded.has(agentSessionId);
  }

  forget(agentSessionId: string): void {
    this.responded.delete(agentSessionId);
  }
}

export interface LinearAgentSessionHooksOptions {
  client: Pick<LinearApiClient, "createAgentActivity" | "updateAgentSession">;
  tracker: LinearAgentSessionTracker;
  /** Public Hub origin, used to give the session a link back to the run. */
  publicBaseUrl?: string | undefined;
}

export interface LinearAgentSessionHooks {
  onDispatchAccepted(outputContext: unknown): Promise<void>;
  onAgentExecutionStarted(outputContext: unknown): Promise<void>;
  onAgentExecutionCompleted(
    outputContext: unknown,
    result: TriggerProviderLifecycleResult,
  ): Promise<void>;
  onAgentExecutionFailed(outputContext: unknown, reason: string): Promise<void>;
}

export function createLinearAgentSessionHooks(
  options: LinearAgentSessionHooksOptions,
): LinearAgentSessionHooks {
  async function emit(
    context: LinearAgentSessionOutputContext,
    content: LinearAgentActivityContent,
    operation: string,
    ephemeral?: boolean,
  ): Promise<void> {
    try {
      await options.client.createAgentActivity({
        linearOrganizationId: context.linearOrganizationId,
        agentSessionId: context.agentSessionId,
        content,
        ...(ephemeral === undefined ? {} : { ephemeral }),
      });
    } catch (error) {
      // A session that cannot be narrated is still a session that should run to completion. The
      // rejection reason is kept because a schema mismatch is otherwise invisible from the logs.
      reportFailure(
        error,
        { operation, component: "triggers", provider: "linear" },
        {
          diagnostic: {
            agentSessionId: context.agentSessionId,
            activity: content.type,
            reason: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
  }

  return {
    async onDispatchAccepted(outputContext) {
      if (!isAgentSessionOutputContext(outputContext)) return;
      options.tracker.forget(outputContext.agentSessionId);
      // Linear marks a session unresponsive without an activity within ten seconds of creation.
      await emit(
        outputContext,
        { type: "thought", body: "Picked this up and preparing a workspace." },
        "linear.agent_session.acknowledge",
      );
      if (options.publicBaseUrl === undefined) return;
      try {
        await options.client.updateAgentSession({
          linearOrganizationId: outputContext.linearOrganizationId,
          agentSessionId: outputContext.agentSessionId,
          externalUrls: [{ label: "Paseo Hub", url: options.publicBaseUrl }],
        });
      } catch (error) {
        reportFailure(
          error,
          {
            operation: "linear.agent_session.external_urls",
            component: "triggers",
            provider: "linear",
          },
          {
            diagnostic: {
              agentSessionId: outputContext.agentSessionId,
              reason: error instanceof Error ? error.message : String(error),
            },
          },
        );
      }
    },

    async onAgentExecutionStarted(outputContext) {
      if (!isAgentSessionOutputContext(outputContext)) return;
      await emit(
        outputContext,
        { type: "thought", body: "The agent is running on your daemon." },
        "linear.agent_session.started",
        true,
      );
    },

    async onAgentExecutionCompleted(outputContext, result) {
      if (!isAgentSessionOutputContext(outputContext)) return;
      if (result.status === "failed") {
        await emit(
          outputContext,
          { type: "error", body: errorBody(result.summary ?? "The run did not finish.") },
          "linear.agent_session.failed",
        );
        options.tracker.forget(outputContext.agentSessionId);
        return;
      }
      if (!options.tracker.hasResponded(outputContext.agentSessionId)) {
        await emit(
          outputContext,
          {
            type: "response",
            body: result.summary ?? "Finished, but the agent did not leave a reply.",
          },
          "linear.agent_session.completed",
        );
      }
      options.tracker.forget(outputContext.agentSessionId);
    },

    async onAgentExecutionFailed(outputContext, reason) {
      if (!isAgentSessionOutputContext(outputContext)) return;
      await emit(
        outputContext,
        { type: "error", body: errorBody(reason) },
        "linear.agent_session.error",
      );
      options.tracker.forget(outputContext.agentSessionId);
    },
  };
}

function errorBody(reason: string): string {
  const trimmed = reason.trim();
  const body = trimmed.length === 0 ? "The run did not finish." : trimmed;
  return body.length > MAX_ERROR_BODY ? `${body.slice(0, MAX_ERROR_BODY)}…` : body;
}
