import type { ConnectionResolver } from "../../config/connections.js";
import type {
  CompiledProjectConfiguration,
  ProjectConfigurationStore,
} from "../../configuration/store.js";
import type { DaemonEnvironmentTarget } from "../../dispatcher/launch-machine-intent.js";
import { logger } from "../../logger.js";
import { cleanTriggerAgent, type TriggerProvider, type TriggerProviderMatch } from "../index.js";
import type { SlackBotClient } from "./client.js";
import { NormalizedSlackMentionEventSchema, type NormalizedSlackMentionEvent } from "./events.js";
import { matchSlackTriggers, readSlackPromptBody } from "./match.js";

export interface SlackMergeData {
  slack: {
    event_type: "app_mention";
    event_id: string;
    event_ts: string;
    event_time: number;
    team: { id: string };
    app: { id: string };
    trigger_message: {
      ts: string;
      content: string;
      body: string;
      author: { id: string };
      channel: { id: string };
      thread: { ts: string } | null;
      created_at: string;
    };
  };
}

export interface SlackTriggerContext {
  provider: "slack";
  target: SlackOutputContext;
  event: SlackMergeData;
}

export interface SlackOutputContext {
  provider: "slack";
  organizationId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
}

export function createSlackTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  connectionsForProject?: (projectId: string) => ConnectionResolver;
  botUserIdForWorkspace(organizationId: string, teamId: string): Promise<string | undefined>;
  client: SlackBotClient;
}): TriggerProvider<"slack", SlackTriggerContext, SlackOutputContext> {
  return {
    name: "slack",
    eventNames: ["slack.mention"],
    async match(trigger) {
      const event = NormalizedSlackMentionEventSchema.parse(trigger.payload);
      const botUserId = await options.botUserIdForWorkspace(trigger.organizationId, event.teamId);
      if (botUserId === undefined) return [];
      const stored = await options.configurationStoreForProject(trigger.projectId).getActive();
      if (stored === undefined) return [];
      const matches: TriggerProviderMatch<SlackTriggerContext, SlackOutputContext>[] = [];

      for (const match of matchSlackTriggers(
        stored.configuration,
        event,
        botUserId,
        trigger.connectionId,
      )) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiledTrigger === undefined)
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
        const step = compiledTrigger.steps[0];
        const baseEnvironment = readDaemonEnvironment(stored.configuration, step.environment);
        const outputContext: SlackOutputContext = {
          provider: "slack",
          organizationId: trigger.organizationId,
          teamId: event.teamId,
          channelId: event.channelId,
          threadTs: event.threadTs ?? event.messageTs,
          messageTs: event.messageTs,
        };
        const triggerContext: SlackTriggerContext = {
          provider: "slack",
          target: outputContext,
          event: buildSlackMergeData(event, botUserId),
        };
        matches.push({
          triggerName: match.trigger.name,
          stepId: step.id,
          environmentName: step.environment,
          environment: {
            ...baseEnvironment,
          },
          prompt: step.prompt.map((block) => block.value).join("\n"),
          agent: cleanTriggerAgent(step.agent),
          allowOutputs: cleanAllowedOutputs(step.allowOutputs),
          timeoutMs: step.maxRuntimeMs,
          runTimeoutMs: compiledTrigger.maxRuntimeMs,
          idleTimeoutMs: step.idleTimeoutMs,
          autoArchive: step.autoArchive,
          triggerContext,
          outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
        });
      }
      return matches;
    },
    async materializeLaunch(launch) {
      return {
        prompt: launch.prompt,
        ...(launch.environmentEnv === undefined ? {} : { environmentEnv: launch.environmentEnv }),
        ...(launch.environmentWorktree === undefined
          ? {}
          : { environmentWorktree: launch.environmentWorktree }),
      };
    },
    async onAgentExecutionStarted(context) {
      await replaceReaction(options.client, context.target, "eyes", "hourglass_flowing_sand");
    },
    async onAgentExecutionCompleted(context) {
      await replaceReaction(
        options.client,
        context.target,
        "hourglass_flowing_sand",
        "white_check_mark",
      );
    },
    async onAgentExecutionFailed(context, _output, reason) {
      await failWithNotice(options.client, context.target, reason);
    },
    async onMachineTerminated(context, reason) {
      if (reason === "launch_failed" || reason === "daemon_disconnected") {
        await failWithNotice(options.client, context.target, reason);
      }
    },
  };
}

function buildSlackMergeData(
  event: NormalizedSlackMentionEvent,
  botUserId: string,
): SlackMergeData {
  return {
    slack: {
      event_type: "app_mention",
      event_id: event.id,
      event_ts: event.eventTs,
      event_time: event.eventTime,
      team: { id: event.teamId },
      app: { id: event.appId },
      trigger_message: {
        ts: event.messageTs,
        content: event.content,
        body: readSlackPromptBody(event, botUserId),
        author: event.author,
        channel: { id: event.channelId },
        thread: event.threadTs === null ? null : { ts: event.threadTs },
        created_at: event.createdAt,
      },
    },
  };
}

function readDaemonEnvironment(
  config: CompiledProjectConfiguration,
  name: string,
): DaemonEnvironmentTarget {
  const environment = config.environments.find((item) => item.name === name);
  if (environment === undefined) throw new Error(`environment not found: ${name}`);
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

async function replaceReaction(
  client: SlackBotClient,
  event: SlackOutputContext,
  from: string,
  to: string,
): Promise<void> {
  await removeReactionSafely(client, event, from);
  await addReactionSafely(client, event, to);
}

async function failWithNotice(
  client: SlackBotClient,
  event: SlackOutputContext,
  reason: string,
): Promise<void> {
  await removeReactionSafely(client, event, "eyes");
  await removeReactionSafely(client, event, "hourglass_flowing_sand");
  await addReactionSafely(client, event, "x");
  try {
    await client.sendMessage({
      organizationId: event.organizationId,
      teamId: event.teamId,
      channelId: event.channelId,
      threadTs: event.threadTs,
      content: `Paseo agent failed: ${reason}`,
    });
  } catch (error) {
    logger.warn({ err: error, teamId: event.teamId }, "Slack failure notice failed");
  }
}

async function addReactionSafely(
  client: SlackBotClient,
  event: SlackOutputContext,
  name: string,
): Promise<void> {
  try {
    await client.addReaction({
      organizationId: event.organizationId,
      teamId: event.teamId,
      channelId: event.channelId,
      messageTs: event.messageTs,
      name,
    });
  } catch (error) {
    logger.warn({ err: error, teamId: event.teamId, name }, "Slack reaction failed");
  }
}

async function removeReactionSafely(
  client: SlackBotClient,
  event: SlackOutputContext,
  name: string,
): Promise<void> {
  try {
    await client.removeReaction({
      organizationId: event.organizationId,
      teamId: event.teamId,
      channelId: event.channelId,
      messageTs: event.messageTs,
      name,
    });
  } catch (error) {
    logger.warn({ err: error, teamId: event.teamId, name }, "Slack reaction cleanup failed");
  }
}
