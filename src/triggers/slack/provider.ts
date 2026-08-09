import type { ConnectionResolver } from "../../config/connections.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentDescriptor,
} from "../../attachments/capabilities.js";
import { logger } from "../../logger.js";
import { type TriggerProvider, type TriggerProviderMatch } from "../index.js";
import type { SlackBotClient, SlackThreadMessage } from "./client.js";
import { NormalizedSlackMentionEventSchema, type NormalizedSlackMentionEvent } from "./events.js";
import {
  matchSlackTriggers,
  readSlackInvocationParserMessage,
  readSlackPromptBody,
} from "./match.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";

export interface SlackAttachmentLocator {
  id: string;
  filename: string;
  content_type: string | null;
  size: number | null;
}

interface SlackThreadContextLocator {
  status: "deferred";
  channel: { id: string };
  thread: { ts: string };
  before: { ts: string };
}

export interface SlackMergeData {
  slack: {
    event_type: "app_mention";
    event_id: string;
    event_ts: string;
    event_time: number;
    connection_id: string | null;
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
      attachments: SlackAttachmentLocator[];
    };
    trigger_thread_context:
      | SlackThreadContextLocator
      | {
          status: "not_applicable";
        };
  };
}

interface SlackMergeMessage {
  ts: string;
  content: string;
  author: { id: string };
  channel: { id: string };
  created_at: string;
  attachments: AttachmentDescriptor[];
}

interface SlackContextPayload {
  status: "available" | "incomplete" | "unavailable" | "not_applicable";
  messages: SlackMergeMessage[];
}

export interface SlackMaterializedContext {
  slack: {
    thread: SlackContextPayload;
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
  attachments?: AttachmentCapabilityRegistry;
}): TriggerProvider<"slack", SlackTriggerContext, SlackOutputContext, SlackMaterializedContext> {
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
          teamId: rawEvent.teamId,
          channelId: rawEvent.channelId,
          threadTs: rawEvent.threadTs ?? rawEvent.messageTs,
          messageTs: rawEvent.messageTs,
        };
        const triggerContext: SlackTriggerContext = {
          provider: "slack",
          target: outputContext,
          event: buildSlackMergeData(rawEvent, botUserId, trigger.connectionId),
        };
        const invocation = parseInvocation(
          rawEvent.content,
          compiledTrigger.inputs,
          undefined,
          readSlackInvocationParserMessage(rawEvent, botUserId, compiledTrigger.filters),
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
    async materializeContext(launch): Promise<SlackMaterializedContext> {
      const locator = launch.triggerContext.event.slack.trigger_thread_context;
      if (locator.status === "not_applicable") {
        return { slack: { thread: { status: "not_applicable", messages: [] } } };
      }
      if (options.client.readThreadMessages === undefined) {
        return { slack: { thread: { status: "unavailable", messages: [] } } };
      }
      let history;
      try {
        history = await options.client.readThreadMessages({
          organizationId: launch.organizationId,
          teamId: launch.triggerContext.event.slack.team.id,
          channelId: locator.channel.id,
          threadTs: locator.thread.ts,
          beforeTs: locator.before.ts,
        });
      } catch (error) {
        logger.warn(
          {
            err: error,
            teamId: launch.triggerContext.event.slack.team.id,
            channelId: locator.channel.id,
          },
          "Slack thread context hydration failed",
        );
        return { slack: { thread: { status: "unavailable", messages: [] } } };
      }
      const messages = await Promise.all(
        history.messages.map(async (message) => ({
          ts: message.ts,
          content: message.content,
          author: message.author,
          channel: { id: locator.channel.id },
          created_at: message.createdAt,
          attachments: await registerAttachments(
            message.attachments,
            launch.providerEventReceiptId,
            launch.organizationId,
            launch.triggerContext.event.slack.team.id,
            launch.triggerContext.event.slack.connection_id,
            launch.executionId,
            options.attachments,
          ),
        })),
      );
      return {
        slack: {
          thread: {
            status: history.complete ? "available" : "incomplete",
            messages,
          },
        },
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
function buildSlackMergeData(
  event: NormalizedSlackMentionEvent,
  botUserId: string,
  connectionId: string | null | undefined,
): SlackMergeData {
  return {
    slack: {
      event_type: "app_mention",
      event_id: event.id,
      event_ts: event.eventTs,
      event_time: event.eventTime,
      connection_id: connectionId ?? null,
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
        attachments: event.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          content_type: attachment.contentType,
          size: attachment.size,
        })),
      },
      trigger_thread_context:
        event.threadTs === null
          ? { status: "not_applicable" }
          : {
              status: "deferred",
              channel: { id: event.channelId },
              thread: { ts: event.threadTs },
              before: { ts: event.messageTs },
            },
    },
  };
}

async function registerAttachments(
  source: SlackThreadMessage["attachments"],
  providerEventReceiptId: string,
  organizationId: string,
  teamId: string,
  connectionId: string | null,
  executionId: string,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<AttachmentDescriptor[]> {
  if (source.length === 0) return [];
  if (attachments === undefined) throw new Error("attachment capability unavailable");
  if (connectionId === null) {
    throw new Error("attachment ownership unavailable");
  }
  const references = await Promise.all(
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
  return references.map((reference) => attachments.materialize(reference, executionId));
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
