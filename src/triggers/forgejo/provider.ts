import { z } from "zod";
import type { JsonValue } from "../../config/compiler.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import { type TriggerProvider, type TriggerProviderReactionState } from "../index.js";
import { reportFailure } from "../../failures/index.js";
import { forgeItemReactionSubjectForEvent } from "../forge/reaction-subject.js";
import { reactToForgeLifecycle } from "../forge/reaction-lifecycle.js";
import { buildForgeTriggerMatches } from "../forge/match-loop.js";
import type { ForgejoApiClient, ForgejoCredentials } from "../../providers/forgejo/client.js";
import type {
  ForgejoReactionContent,
  ForgejoReactionSubject,
} from "../../providers/forgejo/client.js";
import {
  classifyForgejoEvent,
  FORGEJO_TRIGGER_SOURCE_NAMES,
  NormalizedForgejoEventSchema,
} from "./events.js";
import type { ForgejoClassifiedEvent, NormalizedForgejoEvent } from "./events.js";
import { matchForgejoTriggers } from "./match.js";
import { splitForgejoRepository } from "./repository.js";

export type {
  ForgejoReactionContent,
  ForgejoReactionSubject,
} from "../../providers/forgejo/client.js";

/** Creates and deletes the doer's own reaction on the item or comment a trigger fired
 * from. Resolves credentials from the connection, like `forgejo.reply` does. */
export interface ForgejoReactionClient {
  createReaction(input: {
    connectionId: string;
    repo: string;
    subject: ForgejoReactionSubject;
    content: ForgejoReactionContent;
  }): Promise<void>;
  deleteReaction(input: {
    connectionId: string;
    repo: string;
    subject: ForgejoReactionSubject;
    content: ForgejoReactionContent;
  }): Promise<void>;
}

export function createForgejoReactionClient(options: {
  api: Pick<ForgejoApiClient, "createReaction" | "deleteReaction">;
  credentialsForConnection(connectionId: string): Promise<ForgejoCredentials>;
}): ForgejoReactionClient {
  return {
    async createReaction(input) {
      const [owner, repo] = splitForgejoRepository(input.repo);
      await options.api.createReaction({
        credentials: await options.credentialsForConnection(input.connectionId),
        owner,
        repo,
        subject: input.subject,
        content: input.content,
      });
    },
    async deleteReaction(input) {
      const [owner, repo] = splitForgejoRepository(input.repo);
      await options.api.deleteReaction({
        credentials: await options.credentialsForConnection(input.connectionId),
        owner,
        repo,
        subject: input.subject,
        content: input.content,
      });
    },
  };
}

/** Where a reply goes back to. The connection carries the instance and the token. */
export interface ForgejoOutputContext {
  provider: "forgejo";
  connectionId: string;
  repository: string;
  issueNumber: number | null;
}

export interface ForgejoTriggerContext {
  provider: "forgejo";
  target: ForgejoOutputContext;
  event: ForgejoMergeData;
  reactionSubject: ForgejoReactionSubject | null;
}

interface ForgejoReactionState {
  readonly [key: string]: JsonValue;
  readonly content: ForgejoReactionContent;
}

export interface ForgejoMergeData {
  forgejo: {
    delivery_id: string;
    event_name: string;
    repository: { full_name: string };
    received_at: string;
    item: ForgejoContextItem | null;
    /** Present only when enrichment found an addition. */
    added_labels?: string[];
    added_assignees?: string[];
    /** Present only for a pull_request_review event with a verdict; a plain comment
     * raises no semantic event and gets no review context either. */
    review?: { verdict: "approved" | "rejected"; content: string };
    requested_reviewer?: string;
    push?: { ref: string; head_commit: ForgejoHeadCommit | null };
    ci_run?: ForgejoCiRunContext;
  };
}

interface ForgejoContextItem {
  type: "issue" | "pull_request";
  number: number | null;
  title: string | null;
  body: string | null;
  url: string | null;
  author: { login: string } | null;
}

interface ForgejoHeadCommit {
  id: string;
  message: string;
}

interface ForgejoCiRunContext {
  id: number;
  workflow_id: string;
  status: string;
  /** prettyref: a display ref, not proof of a branch. The branches filter never reads this. */
  ref: string;
  commit_sha: string;
  html_url: string;
  trigger_user: string | null;
}

const ForgejoPushPayloadSchema = z
  .object({
    ref: z.string().optional().catch(undefined),
    head_commit: z
      .object({
        id: z.string().optional().catch(undefined),
        message: z.string().optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

/** push carries no issue or pull request, only a ref and its head commit. */
function forgejoPushContext(event: NormalizedForgejoEvent): ForgejoMergeData["forgejo"]["push"] {
  if (event.type !== "push") return undefined;
  const parsed = ForgejoPushPayloadSchema.safeParse(event.payload).data;
  if (parsed?.ref === undefined) return undefined;
  const headCommit =
    parsed.head_commit?.id === undefined
      ? null
      : { id: parsed.head_commit.id, message: parsed.head_commit.message ?? "" };
  return { ref: parsed.ref, head_commit: headCommit };
}

const ForgejoActionRunContextPayloadSchema = z
  .object({
    run: z
      .object({
        id: z.number().optional().catch(undefined),
        workflow_id: z.string().optional().catch(undefined),
        status: z.string().optional().catch(undefined),
        prettyref: z.string().optional().catch(undefined),
        commit_sha: z.string().optional().catch(undefined),
        html_url: z.string().optional().catch(undefined),
        trigger_user: z
          .object({ login: z.string().optional().catch(undefined) })
          .passthrough()
          .optional()
          .catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

/**
 * action_run_failure/action_run_success carry no issue or pull request, only the CI
 * run itself. ref here is the run's prettyref, which strips refs/heads and refs/tags
 * to the same bare name (and spells a PR-triggered run as #N), a display string, not
 * proof of a branch. That's why the branches filter is restricted to forgejo.push.
 */
function forgejoCiRunContext(event: NormalizedForgejoEvent): ForgejoMergeData["forgejo"]["ci_run"] {
  if (event.type !== "action_run_failure" && event.type !== "action_run_success") return undefined;
  const run = ForgejoActionRunContextPayloadSchema.safeParse(event.payload).data?.run;
  if (run?.id === undefined) return undefined;
  return {
    id: run.id,
    workflow_id: run.workflow_id ?? "",
    status: run.status ?? "",
    ref: run.prettyref ?? "",
    commit_sha: run.commit_sha ?? "",
    html_url: run.html_url ?? "",
    trigger_user: run.trigger_user?.login ?? null,
  };
}

export function createForgejoTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  reactions: ForgejoReactionClient;
}): TriggerProvider<"forgejo", ForgejoTriggerContext, ForgejoOutputContext, ForgejoMergeData> {
  return {
    name: "forgejo",
    eventNames: [...FORGEJO_TRIGGER_SOURCE_NAMES],
    async match(externalTrigger) {
      const event = NormalizedForgejoEventSchema.parse(externalTrigger.payload);
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";

      const classified = classifyForgejoEvent(event);
      if (
        !stored.configuration.triggers.some((candidate) =>
          [externalTrigger.source, classified.semanticEvent].includes(candidate.on),
        )
      ) {
        return "no_trigger_for_source";
      }

      // Forgejo raises no separate review-comment webhook, so unlike GitHub there's no
      // third subject kind here; pull_request_review itself gets no reaction.
      const reactionSubject = forgeItemReactionSubjectForEvent(event);

      return buildForgeTriggerMatches({
        matches: matchForgejoTriggers(stored.configuration, event, externalTrigger.connectionId),
        triggers: stored.configuration.triggers,
        message: classified.text,
        revisionId: stored.revision.id,
        hubConfig: stored.configuration,
        contextFor: () => {
          const outputContext: ForgejoOutputContext = {
            provider: "forgejo",
            connectionId: event.connectionId,
            repository: event.repo,
            issueNumber: classified.item?.number ?? null,
          };
          const triggerContext: ForgejoTriggerContext = {
            provider: "forgejo",
            target: outputContext,
            event: buildForgejoMergeData(event, classified),
            reactionSubject,
          };
          return {
            triggerContext,
            outputContext,
            conversation: forgejoConversation(event, classified.item),
          };
        },
      });
    },
    async materializeContext(launch) {
      return launch.triggerContext.event;
    },
    async onDispatchAccepted(triggerContext, _outputContext, reactionState) {
      if (triggerContext.reactionSubject === null) return null;
      if (forgejoReactionContent(reactionState) !== undefined) return reactionState;
      await options.reactions.createReaction({
        connectionId: triggerContext.target.connectionId,
        repo: triggerContext.target.repository,
        subject: triggerContext.reactionSubject,
        content: "eyes",
      });
      return { content: "eyes" } satisfies ForgejoReactionState;
    },
    async onAgentExecutionCompleted(triggerContext, _outputContext, _result, reactionState) {
      return reactToForgejoLifecycle(options.reactions, triggerContext, "+1", reactionState);
    },
    async onAgentExecutionFailed(triggerContext, _outputContext, _reason, reactionState) {
      return reactToForgejoLifecycle(options.reactions, triggerContext, "-1", reactionState);
    },
    async onMachineTerminated(triggerContext, _reason, reactionState) {
      return reactToForgejoLifecycle(options.reactions, triggerContext, "-1", reactionState);
    },
  };
}

async function reactToForgejoLifecycle(
  reactions: ForgejoReactionClient,
  triggerContext: ForgejoTriggerContext,
  content: ForgejoReactionContent,
  reactionState?: TriggerProviderReactionState,
): Promise<ForgejoReactionState | null> {
  const previousContent = forgejoReactionContent(reactionState);
  return reactToForgeLifecycle(
    triggerContext.reactionSubject,
    previousContent,
    (subject, previous) =>
      reactions.deleteReaction({
        connectionId: triggerContext.target.connectionId,
        repo: triggerContext.target.repository,
        subject,
        content: previous,
      }),
    async (subject) => {
      await reactions.createReaction({
        connectionId: triggerContext.target.connectionId,
        repo: triggerContext.target.repository,
        subject,
        content,
      });
      return { content } satisfies ForgejoReactionState;
    },
    (error) =>
      reportFailure(
        error,
        { operation: "forgejo.reaction.cleanup", component: "triggers", provider: "forgejo" },
        { diagnostic: { repository: triggerContext.target.repository, content: previousContent } },
      ),
  );
}

function forgejoReactionContent(
  state: TriggerProviderReactionState | undefined,
): ForgejoReactionContent | undefined {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return undefined;
  const content = state["content"];
  return content === "+1" || content === "-1" || content === "eyes" ? content : undefined;
}

function buildForgejoMergeData(
  event: NormalizedForgejoEvent,
  classified: ForgejoClassifiedEvent,
): ForgejoMergeData {
  const review = forgejoReviewContext(classified);
  const push = forgejoPushContext(event);
  const ciRun = forgejoCiRunContext(event);
  return {
    forgejo: {
      delivery_id: event.id,
      event_name: event.type,
      repository: { full_name: event.repo },
      received_at: event.createdAt,
      item: classified.item,
      ...(classified.addedLabels.length === 0 ? {} : { added_labels: [...classified.addedLabels] }),
      ...(classified.addedAssignees.length === 0
        ? {}
        : { added_assignees: [...classified.addedAssignees] }),
      ...(review === undefined ? {} : { review }),
      ...(classified.requestedReviewer === undefined
        ? {}
        : { requested_reviewer: classified.requestedReviewer }),
      ...(push === undefined ? {} : { push }),
      ...(ciRun === undefined ? {} : { ci_run: ciRun }),
    },
  };
}

function forgejoReviewContext(
  classified: ForgejoClassifiedEvent,
): ForgejoMergeData["forgejo"]["review"] {
  if (classified.semanticEvent === "forgejo.pull_request_review_approved") {
    return { verdict: "approved", content: classified.text };
  }
  if (classified.semanticEvent === "forgejo.pull_request_review_rejected") {
    return { verdict: "rejected", content: classified.text };
  }
  return undefined;
}

/**
 * Thread key for repeat events on one issue. Keyed on repositoryId, not event.repo,
 * since a repository can be renamed. Connection is part of the key too, since two
 * instances can host a repository with the same id.
 */
function forgejoConversation(
  event: NormalizedForgejoEvent,
  item: ForgejoContextItem | null,
): import("../continuation.js").Conversation | null {
  const number = item?.number;
  if (number === undefined || number === null) return null;
  return {
    key: JSON.stringify(["forgejo", event.connectionId, event.repositoryId, number]),
    label: `${event.repo}#${String(number)}`,
    ...(item?.url == null ? {} : { url: item.url }),
  };
}
