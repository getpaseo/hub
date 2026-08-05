import type { ConnectionResolver, InterpolationContext } from "../../config/index.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentDescriptor,
  AttachmentReference,
} from "../../attachments/capabilities.js";
import type {
  CompiledProjectConfiguration,
  ProjectConfigurationStore,
} from "../../configuration/store.js";
import {
  createInterpolationContext,
  interpolateRecord,
  interpolateTemplate,
  interpolateWorktree,
  parseTemplate,
  parseTriggerTimeoutMs,
} from "../../config/index.js";
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
      attachments: AttachmentReference[] | AttachmentDescriptor[];
    };
    trigger_thread_context: { messages: SlackMergeMessage[] };
  };
}

interface SlackMergeMessage {
  ts: string;
  content: string;
  author: { id: string };
  channel: { id: string };
  created_at: string;
  attachments: AttachmentReference[] | AttachmentDescriptor[];
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
  attachments?: AttachmentCapabilityRegistry;
}): TriggerProvider<"slack", SlackTriggerContext, SlackOutputContext> {
  return {
    name: "slack",
    eventNames: ["slack.mention"],
    async match(trigger) {
      const event = await hydrateSlackEvent(
        NormalizedSlackMentionEventSchema.parse(trigger.payload),
        trigger.organizationId,
        options.client,
      );
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
        const baseEnvironment = readDaemonEnvironment(
          stored.configuration,
          match.trigger.environment,
        );
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
          event: await buildSlackMergeData(
            event,
            botUserId,
            trigger.triggerId,
            trigger.organizationId,
            event.teamId,
            trigger.connectionId,
            options.attachments,
          ),
        };
        matches.push({
          triggerName: match.trigger.name,
          environmentName: match.trigger.environment,
          environment: {
            ...baseEnvironment,
            ...(match.trigger.env === undefined
              ? {}
              : {
                  env: Object.fromEntries(
                    Object.entries(match.trigger.env).map(([key, value]) => [key, value.value]),
                  ),
                }),
          },
          prompt: match.trigger.prompt.value,
          agent: cleanTriggerAgent(match.trigger.agent),
          allowOutputs: cleanAllowedOutputs(match.trigger.allow_outputs ?? []),
          timeoutMs: parseTriggerTimeoutMs(match.trigger.timeout),
          idleTimeoutMs: parseTriggerTimeoutMs(match.trigger.idle_timeout),
          autoArchive: match.trigger.auto_archive,
          triggerContext,
          outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
        });
      }
      return matches;
    },
    async materializeLaunch(launch) {
      const event = await materializeSlackMergeData(
        launch.triggerContext.event,
        launch.executionId,
        options.attachments,
      );
      const context = buildInterpolationContext(
        event,
        withExecutionContext(options.connectionsForProject?.(launch.projectId), launch.executionId),
      );
      const [prompt, environmentEnv, environmentWorktree] = await Promise.all([
        interpolateTemplate(parseTemplate(launch.prompt), context),
        interpolateRecord(
          launch.environmentEnv === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(launch.environmentEnv).map(([key, value]) => [
                  key,
                  parseTemplate(value),
                ]),
              ),
          context,
        ),
        launch.environmentWorktree === undefined
          ? undefined
          : interpolateWorktree(launch.environmentWorktree, context),
      ]);
      return {
        prompt,
        ...(Object.keys(environmentEnv).length === 0 ? {} : { environmentEnv }),
        ...(environmentWorktree === undefined ? {} : { environmentWorktree }),
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

function buildInterpolationContext(
  event: SlackMergeData,
  connections: ConnectionResolver | undefined,
): InterpolationContext {
  return createInterpolationContext(event, connections);
}

function withExecutionContext(
  connections: ConnectionResolver | undefined,
  executionId: string,
): ConnectionResolver | undefined {
  if (connections === undefined) return undefined;
  return (connectionSlug, value) => connections(connectionSlug, value, { executionId });
}

async function hydrateSlackEvent(
  event: NormalizedSlackMentionEvent,
  organizationId: string,
  client: SlackBotClient,
): Promise<NormalizedSlackMentionEvent> {
  if (event.threadTs === null || client.readThreadMessages === undefined) return event;
  try {
    const messages = await client.readThreadMessages({
      organizationId,
      teamId: event.teamId,
      channelId: event.channelId,
      threadTs: event.threadTs,
      beforeTs: event.messageTs,
    });
    return {
      ...event,
      threadContextMessages: messages.map((message) => ({
        ts: message.ts,
        createdAt: message.createdAt,
        content: message.content,
        author: message.author,
        attachments: message.attachments,
      })),
    };
  } catch (error) {
    logger.warn(
      { err: error, teamId: event.teamId, channelId: event.channelId },
      "Slack thread context hydration failed",
    );
    return { ...event, threadContextMessages: [] };
  }
}

async function buildSlackMergeData(
  event: NormalizedSlackMentionEvent,
  botUserId: string,
  triggerId: string | undefined,
  organizationId: string,
  teamId: string,
  connectionId: string | null | undefined,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<SlackMergeData> {
  const triggerAttachments = await registerAttachments(
    event.attachments,
    triggerId,
    organizationId,
    teamId,
    connectionId,
    attachments,
  );
  const contextMessages = await Promise.all(
    event.threadContextMessages.map(async (message) => ({
      ts: message.ts,
      content: message.content,
      author: message.author,
      channel: { id: event.channelId },
      created_at: message.createdAt,
      attachments: await registerAttachments(
        message.attachments,
        triggerId,
        organizationId,
        teamId,
        connectionId,
        attachments,
      ),
    })),
  );
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
        attachments: triggerAttachments,
      },
      trigger_thread_context: { messages: contextMessages },
    },
  };
}

async function registerAttachments(
  source: NormalizedSlackMentionEvent["attachments"],
  triggerId: string | undefined,
  organizationId: string,
  teamId: string,
  connectionId: string | null | undefined,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<AttachmentReference[]> {
  if (source.length === 0) return [];
  if (attachments === undefined) throw new Error("attachment capability unavailable");
  if (triggerId === undefined || connectionId === null || connectionId === undefined) {
    throw new Error("attachment ownership unavailable");
  }
  return Promise.all(
    source.map((file) =>
      attachments.register({
        triggerId,
        organizationId,
        connectionId,
        provider: "slack",
        sourceId: file.id,
        locator: { teamId, fileId: file.id },
        filename: file.filename,
        contentType: file.contentType,
        byteSize: file.size,
      }),
    ),
  );
}

async function materializeSlackMergeData(
  event: SlackMergeData,
  executionId: string,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<SlackMergeData> {
  const materialize = (attachment: AttachmentReference | AttachmentDescriptor) => {
    if ("url" in attachment) return attachment;
    if (attachments === undefined) throw new Error("attachment capability unavailable");
    return attachments.materialize(attachment, executionId);
  };
  return {
    slack: {
      ...event.slack,
      trigger_message: {
        ...event.slack.trigger_message,
        attachments: event.slack.trigger_message.attachments.map(materialize),
      },
      trigger_thread_context: {
        messages: event.slack.trigger_thread_context.messages.map((message) => ({
          ...message,
          attachments: message.attachments.map(materialize),
        })),
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
