import type { ConnectionResolver } from "../../config/connections.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentDescriptor,
  AttachmentReference,
} from "../../attachments/capabilities.js";
import { logger } from "../../logger.js";
import { type TriggerProvider, type TriggerProviderMatch } from "../index.js";
import type { SlackBotClient } from "./client.js";
import { NormalizedSlackMentionEventSchema, type NormalizedSlackMentionEvent } from "./events.js";
import {
  matchSlackTriggers,
  readSlackInvocationParserMessage,
  readSlackPromptBody,
} from "./match.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";

const MAX_THREAD_CONTEXT_MESSAGES = 50;

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
    trigger_thread_context: {
      status: "available" | "unavailable" | "not_applicable";
      messages: SlackMergeMessage[];
    };
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
      const rawEvent = NormalizedSlackMentionEventSchema.parse(trigger.payload);
      const botUserId = await options.botUserIdForWorkspace(
        trigger.organizationId,
        rawEvent.teamId,
      );
      if (botUserId === undefined) return [];
      const stored = await options
        .configurationStoreForProject(trigger.projectId)
        .getRevision(trigger.configurationRevisionId);
      if (stored === undefined) return [];
      const matchedTriggers = matchSlackTriggers(
        stored.configuration,
        rawEvent,
        botUserId,
        trigger.connectionId,
      );
      if (matchedTriggers.length === 0) return [];
      const event = await hydrateSlackEvent(rawEvent, trigger.organizationId, options.client);
      const matches: TriggerProviderMatch<SlackTriggerContext, SlackOutputContext>[] = [];

      for (const match of matchedTriggers) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiledTrigger === undefined)
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
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
            trigger.providerEventReceiptId,
            trigger.organizationId,
            event.teamId,
            trigger.connectionId,
            options.attachments,
          ),
        };
        const invocation = parseInvocation(
          event.content,
          compiledTrigger.inputs,
          undefined,
          readSlackInvocationParserMessage(event, botUserId, compiledTrigger.filters),
        );
        if (invocation.status === "accepted") {
          if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
        }
        if (invocation.status === "rejected") {
          matches.push({
            triggerName: match.trigger.name,
            triggerContext,
            outputContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          });
          continue;
        }
        matches.push({
          triggerName: match.trigger.name,
          triggerContext,
          outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
          invocation,
        });
      }
      return matches;
    },
    async materializeContext(launch) {
      const event = await materializeSlackMergeData(
        launch.triggerContext.event,
        launch.executionId,
        options.attachments,
      );
      return {
        slack: { thread: event.slack.trigger_thread_context },
      };
    },
    async onAgentExecutionStarted(context) {
      await replaceReaction(options.client, context.target, "eyes", "hourglass_flowing_sand");
    },
    async onAgentExecutionCompleted(context) {
      await removeReactionSafely(options.client, context.target, "hourglass_flowing_sand");
      await addReaction(options.client, context.target, "white_check_mark");
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

async function hydrateSlackEvent(
  event: NormalizedSlackMentionEvent,
  organizationId: string,
  client: SlackBotClient,
): Promise<HydratedSlackEvent> {
  if (event.threadTs === null) return { ...event, threadContextStatus: "not_applicable" };
  if (client.readThreadMessages === undefined) {
    return { ...event, threadContextStatus: "unavailable" };
  }
  try {
    const messages = await client.readThreadMessages({
      organizationId,
      teamId: event.teamId,
      channelId: event.channelId,
      threadTs: event.threadTs,
      beforeTs: event.messageTs,
    });
    const preceding = messages
      .filter((message) => compareSlackTimestamps(message.ts, event.messageTs) < 0)
      .sort((left, right) => compareSlackTimestamps(left.ts, right.ts))
      .slice(-MAX_THREAD_CONTEXT_MESSAGES);
    return {
      ...event,
      threadContextMessages: preceding.map((message) => ({
        ts: message.ts,
        createdAt: message.createdAt,
        content: message.content,
        author: message.author,
        attachments: message.attachments,
      })),
      threadContextStatus: "available",
    };
  } catch (error) {
    logger.warn(
      { err: error, teamId: event.teamId, channelId: event.channelId },
      "Slack thread context hydration failed",
    );
    return { ...event, threadContextMessages: [], threadContextStatus: "unavailable" };
  }
}

type HydratedSlackEvent = NormalizedSlackMentionEvent & {
  threadContextStatus: "available" | "unavailable" | "not_applicable";
};

function compareSlackTimestamps(left: string, right: string): number {
  return Number(left) - Number(right);
}

async function buildSlackMergeData(
  event: HydratedSlackEvent,
  botUserId: string,
  providerEventReceiptId: string,
  organizationId: string,
  teamId: string,
  connectionId: string | null | undefined,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<SlackMergeData> {
  const triggerAttachments = await registerAttachments(
    event.attachments,
    providerEventReceiptId,
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
        providerEventReceiptId,
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
      trigger_thread_context: {
        status: event.threadContextStatus,
        messages: contextMessages,
      },
    },
  };
}

async function registerAttachments(
  source: NormalizedSlackMentionEvent["attachments"],
  providerEventReceiptId: string,
  organizationId: string,
  teamId: string,
  connectionId: string | null | undefined,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<AttachmentReference[]> {
  if (source.length === 0) return [];
  if (attachments === undefined) throw new Error("attachment capability unavailable");
  if (connectionId === null || connectionId === undefined) {
    throw new Error("attachment ownership unavailable");
  }
  return Promise.all(
    source.map((file) =>
      attachments.register({
        providerEventReceiptId,
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
        status: event.slack.trigger_thread_context.status,
        messages: event.slack.trigger_thread_context.messages.map((message) => ({
          ...message,
          attachments: message.attachments.map(materialize),
        })),
      },
    },
  };
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
  await addReaction(client, event, "x");
  await client.sendMessage({
    organizationId: event.organizationId,
    teamId: event.teamId,
    channelId: event.channelId,
    threadTs: event.threadTs,
    content: `Paseo agent failed: ${reason}`,
  });
}

async function addReaction(
  client: SlackBotClient,
  event: SlackOutputContext,
  name: string,
): Promise<void> {
  await client.addReaction({
    organizationId: event.organizationId,
    teamId: event.teamId,
    channelId: event.channelId,
    messageTs: event.messageTs,
    name,
  });
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
