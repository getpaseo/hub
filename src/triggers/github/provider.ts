import type { ConnectionResolver } from "../../config/connections.js";
import type {
  CompiledProjectConfiguration,
  ProjectConfigurationStore,
} from "../../configuration/store.js";
import type { DaemonEnvironmentTarget } from "../../dispatcher/launch-machine-intent.js";
import { cleanTriggerAgent, type TriggerProvider, type TriggerProviderMatch } from "../index.js";
import type { GitHubAuth, GitHubExecutionTokenAuth } from "../../auth/github.js";
import { logger } from "../../logger.js";
import { matchTriggers, readGitHubInvocationMessage, readGitHubMention } from "./match.js";
import { interpolateInvocation, matchesInputFilters, parseInvocation } from "../invocation.js";
import {
  IssueCommentPayloadSchema,
  NormalizedGitHubEventSchema,
  PullRequestReviewCommentPayloadSchema,
  readGitHubTriggerUrl,
} from "../../auth/github-events.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";

const TOKEN_REVOCATION_TIMEOUT_MS = 10_000;

interface ExecutionTokenState {
  pendingMints: number;
  terminal: boolean;
  tokens: Set<string>;
}

export interface GitHubReactionClient {
  createReaction(input: {
    installationId: number;
    repo: string;
    subject: GitHubReactionSubject;
    content: GitHubReactionContent;
  }): Promise<GitHubCreatedReaction>;
  deleteReaction(input: {
    installationId: number;
    repo: string;
    subject: GitHubReactionSubject;
    reactionId: number;
  }): Promise<void>;
}

export interface GitHubCreatedReaction {
  id: number;
}

export type GitHubReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export interface GitHubMergeData {
  github: Record<string, unknown> & {
    delivery_id: string;
    event_name: string;
    repository_full_name: string;
    installation_id: number;
    received_at: string;
    trigger_url?: string;
  };
}

export function createGitHubReactionClient(auth: GitHubAuth): GitHubReactionClient {
  return {
    async createReaction(input) {
      const [owner, repo] = splitRepo(input.repo);
      const octokit = await auth.createInstallationOctokit(input.installationId);
      const endpoint =
        input.subject.kind === "issue_comment"
          ? "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions"
          : "POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions";

      const response = await octokit.request(endpoint, {
        owner,
        repo,
        comment_id: input.subject.commentId,
        content: input.content,
      });
      return { id: response.data.id };
    },
    async deleteReaction(input) {
      const [owner, repo] = splitRepo(input.repo);
      const octokit = await auth.createInstallationOctokit(input.installationId);
      const endpoint =
        input.subject.kind === "issue_comment"
          ? "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}"
          : "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions/{reaction_id}";

      await octokit.request(endpoint, {
        owner,
        repo,
        comment_id: input.subject.commentId,
        reaction_id: input.reactionId,
      });
    },
  };
}

export type GitHubReactionSubject =
  | { kind: "issue_comment"; commentId: number }
  | { kind: "pull_request_review_comment"; commentId: number };

export interface GitHubTriggerContext {
  provider: "github";
  target: { installationId: number; repository: string };
  event: GitHubMergeData;
  reactionSubject: GitHubReactionSubject | null;
  inProgressReactionId?: number;
}

export function createGitHubTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  connectionsForProject?: (projectId: string) => ConnectionResolver;
  reactions: GitHubReactionClient;
  executionTokens: GitHubExecutionTokenAuth;
}): TriggerProvider<"github", GitHubTriggerContext> {
  const executionTokenStates = new Map<string, ExecutionTokenState>();
  return {
    name: "github",
    eventNames: [
      "github.issue_comment",
      "github.issues",
      "github.pull_request_review",
      "github.pull_request_review_comment",
      "github.push",
    ],
    async match(externalTrigger) {
      const event = NormalizedGitHubEventSchema.parse(externalTrigger.payload);
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getActive();
      if (stored === undefined) return [];
      const matches: TriggerProviderMatch<GitHubTriggerContext>[] = [];

      for (const match of matchTriggers(
        stored.configuration,
        event,
        externalTrigger.connectionId,
      )) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiledTrigger === undefined)
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
        const step = compiledTrigger.steps[0];
        const triggerContext: GitHubTriggerContext = {
          provider: "github",
          target: { installationId: event.installationId, repository: event.repo },
          event: buildGitHubMergeData(event),
          reactionSubject: reactionSubjectForEvent(event),
        };
        const invocation = parseInvocation(
          readGitHubInvocationMessage(event),
          compiledTrigger.inputs,
          readGitHubMention(event, compiledTrigger.filters),
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
        const environmentName = interpolateInvocation(step.environment, invocation);
        const baseEnvironment = readDaemonEnvironment(stored.configuration, environmentName);

        const environment: DaemonEnvironmentTarget = { ...baseEnvironment };

        matches.push({
          triggerName: match.trigger.name,
          stepId: step.id,
          environmentName,
          environment,
          prompt: step.prompt.map((block) => block.value).join("\n"),
          agent: cleanTriggerAgent(step.agent),
          allowOutputs: cleanAllowedOutputs(step.allowOutputs),
          timeoutMs: step.maxRuntimeMs,
          runTimeoutMs: compiledTrigger.maxRuntimeMs,
          idleTimeoutMs: step.idleTimeoutMs,
          autoArchive: step.autoArchive,
          triggerContext,
          outputContext: triggerContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
          invocation,
        });
      }

      return matches;
    },
    async materializeLaunch(launch) {
      const state = executionTokenStates.get(launch.executionId) ?? {
        pendingMints: 0,
        terminal: false,
        tokens: new Set<string>(),
      };
      if (state.terminal) {
        throw new Error(`cannot materialize terminal execution ${launch.executionId}`);
      }
      executionTokenStates.set(launch.executionId, state);
      state.pendingMints += 1;
      let token: string;
      try {
        token = await options.executionTokens.mintExecutionToken({
          installationId: launch.triggerContext.target.installationId,
          repository: launch.triggerContext.target.repository,
        });
      } catch (error) {
        state.pendingMints -= 1;
        deleteEmptyExecutionTokenState(executionTokenStates, launch.executionId, state);
        throw error;
      }
      state.pendingMints -= 1;
      if (state.terminal) {
        await revokeExecutionTokens(options.executionTokens, launch.executionId, [token]);
        deleteEmptyExecutionTokenState(executionTokenStates, launch.executionId, state);
        throw new Error(`cannot materialize terminal execution ${launch.executionId}`);
      }
      state.tokens.add(token);
      state.pendingMints += 1;
      try {
        if (state.terminal) {
          throw new Error(`cannot materialize terminal execution ${launch.executionId}`);
        }
        return {
          prompt: launch.prompt,
          environmentEnv: { ...launch.environmentEnv, GH_TOKEN: token },
          ...(launch.environmentWorktree === undefined
            ? {}
            : { environmentWorktree: launch.environmentWorktree }),
        };
      } finally {
        state.pendingMints -= 1;
        deleteEmptyExecutionTokenState(executionTokenStates, launch.executionId, state);
      }
    },
    async onDispatchAccepted(triggerContext) {
      if (triggerContext.reactionSubject === null) return;
      const reaction = await options.reactions.createReaction({
        installationId: triggerContext.target.installationId,
        repo: triggerContext.target.repository,
        subject: triggerContext.reactionSubject,
        content: "eyes",
      });
      triggerContext.inProgressReactionId = reaction.id;
    },
    async onAgentExecutionStarted(triggerContext) {
      await reactToLifecycle(options.reactions, triggerContext, "rocket");
    },
    async onAgentExecutionCompleted(triggerContext) {
      await createLifecycleReaction(options.reactions, triggerContext, "+1");
    },
    async onAgentExecutionFailed(triggerContext) {
      await reactToLifecycle(options.reactions, triggerContext, "-1");
    },
    async onMachineTerminated(triggerContext) {
      await reactToLifecycle(options.reactions, triggerContext, "-1");
    },
    async onAgentExecutionTerminal(executionId) {
      const state = executionTokenStates.get(executionId) ?? {
        pendingMints: 0,
        terminal: false,
        tokens: new Set<string>(),
      };
      executionTokenStates.set(executionId, state);
      state.terminal = true;
      const tokens = [...state.tokens];
      state.tokens.clear();
      await revokeExecutionTokens(options.executionTokens, executionId, tokens);
      deleteEmptyExecutionTokenState(executionTokenStates, executionId, state);
    },
  };
}

function deleteEmptyExecutionTokenState(
  states: Map<string, ExecutionTokenState>,
  executionId: string,
  state: ExecutionTokenState,
): void {
  if (states.get(executionId) === state && state.pendingMints === 0 && state.tokens.size === 0) {
    states.delete(executionId);
  }
}

async function revokeExecutionTokens(
  executionTokens: GitHubExecutionTokenAuth,
  executionId: string,
  tokens: readonly string[],
): Promise<void> {
  const revocations = await Promise.allSettled(
    tokens.map((token) =>
      withTimeout(executionTokens.revokeInstallationToken(token), TOKEN_REVOCATION_TIMEOUT_MS),
    ),
  );
  for (const result of revocations) {
    if (result.status === "rejected") {
      logger.warn({ err: result.reason, executionId }, "GitHub execution token revocation failed");
    }
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`operation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timeout));
}

function buildGitHubMergeData(event: NormalizedGitHubEvent): GitHubMergeData {
  const url = readGitHubTriggerUrl(event.payload);
  return {
    github: {
      ...event.payload,
      delivery_id: event.id,
      event_name: event.type,
      repository_full_name: event.repo,
      installation_id: event.installationId,
      received_at: event.createdAt,
      ...(url === undefined ? {} : { trigger_url: url }),
    },
  };
}

function readDaemonEnvironment(
  config: CompiledProjectConfiguration,
  environmentName: string,
): DaemonEnvironmentTarget {
  const environment = config.environments.find((item) => item.name === environmentName);

  if (environment === undefined) {
    throw new Error(`environment not found: ${environmentName}`);
  }

  if (environment.kind !== "daemon") {
    throw new Error(`environment kind is not implemented: ${environment.kind}`);
  }

  return {
    kind: "daemon",
    daemonId: environment.daemonId,
    authoredSlug: environment.daemon,
    cwd: environment.cwd,
    ...(environment.worktree === undefined ? {} : { worktree: environment.worktree }),
  };
}

function cleanAllowedOutputs(outputs: readonly { type: string; max: number }[]) {
  return outputs.map((output) => ({ type: output.type, max: output.max }));
}

async function reactToLifecycle(
  reactions: GitHubReactionClient,
  triggerContext: GitHubTriggerContext,
  content: GitHubReactionContent,
): Promise<void> {
  if (triggerContext.reactionSubject === null) {
    return;
  }

  await deleteInProgressReactionSafely(reactions, triggerContext);

  await reactions.createReaction({
    installationId: triggerContext.target.installationId,
    repo: triggerContext.target.repository,
    subject: triggerContext.reactionSubject,
    content,
  });
}

async function createLifecycleReaction(
  reactions: GitHubReactionClient,
  triggerContext: GitHubTriggerContext,
  content: GitHubReactionContent,
): Promise<void> {
  if (triggerContext.reactionSubject === null) {
    return;
  }

  await reactions.createReaction({
    installationId: triggerContext.target.installationId,
    repo: triggerContext.target.repository,
    subject: triggerContext.reactionSubject,
    content,
  });
}

async function deleteInProgressReactionSafely(
  reactions: GitHubReactionClient,
  triggerContext: GitHubTriggerContext,
): Promise<void> {
  if (
    triggerContext.reactionSubject === null ||
    triggerContext.inProgressReactionId === undefined
  ) {
    return;
  }

  try {
    await reactions.deleteReaction({
      installationId: triggerContext.target.installationId,
      repo: triggerContext.target.repository,
      subject: triggerContext.reactionSubject,
      reactionId: triggerContext.inProgressReactionId,
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        repo: triggerContext.target.repository,
        subject: triggerContext.reactionSubject,
        reactionId: triggerContext.inProgressReactionId,
      },
      "github reaction cleanup failed",
    );
  }
}

function reactionSubjectForEvent(event: NormalizedGitHubEvent): GitHubReactionSubject | null {
  if (event.type === "issue_comment") {
    const payload = IssueCommentPayloadSchema.parse(event.payload);
    return payload.comment?.id === undefined
      ? null
      : { kind: "issue_comment", commentId: payload.comment.id };
  }

  if (event.type === "pull_request_review_comment") {
    const payload = PullRequestReviewCommentPayloadSchema.parse(event.payload);
    return payload.comment?.id === undefined
      ? null
      : { kind: "pull_request_review_comment", commentId: payload.comment.id };
  }

  return null;
}

function splitRepo(fullName: string): [owner: string, repo: string] {
  const [owner, repo] = fullName.split("/");

  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    throw new Error(`invalid GitHub repo full name: ${fullName}`);
  }

  return [owner, repo];
}
