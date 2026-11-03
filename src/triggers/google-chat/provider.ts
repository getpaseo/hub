import type { ProjectConfigurationStore } from "../../configuration/store.js";
import { reportFailure } from "../../failures/index.js";
import { agentFailureNotice, missingBillingUrl } from "../failure-notice.js";
import { type TriggerProvider, type TriggerProviderMatch } from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import type { GoogleChatBotClient } from "./client.js";
import {
  NormalizedGoogleChatMentionEventSchema,
  type NormalizedGoogleChatContextMessage,
  type NormalizedGoogleChatMentionEvent,
} from "./events.js";
import {
  matchGoogleChatTriggers,
  readGoogleChatInvocationParserMessage,
  readGoogleChatPromptBody,
} from "./match.js";

export interface GoogleChatMergeMessage {
  id: string;
  content: string;
  author: {
    id: string;
    display_name: string;
    email: string | null;
    bot?: boolean;
  };
  space: {
    name: string;
  };
  created_at: string;
}

interface GoogleChatThreadContextLocator {
  status: "deferred";
  space: { name: string };
  thread: { name: string };
  before: { message_name: string; created_at: string };
}

export interface GoogleChatMergeData {
  google_chat: {
    event_type: "mention";
    connection_id: string | null;
    project: { id: string };
    space: {
      name: string;
      display_name: string | null;
      type: "dm" | "space";
    };
    trigger_message: GoogleChatMergeMessage & {
      body: string;
      thread: { name: string } | null;
    };
    trigger_thread_context:
      | GoogleChatThreadContextLocator
      | {
          status: "not_applicable";
        };
  };
}

export interface GoogleChatMaterializedContext {
  google_chat: {
    thread: {
      status: "available" | "unavailable" | "not_applicable";
      messages: GoogleChatMergeMessage[];
    };
  };
}

export interface GoogleChatOutputContext {
  provider: "google-chat";
  projectId: string;
  spaceName: string;
  threadName: string | null;
  messageName: string;
}

export interface GoogleChatTriggerContext {
  provider: "google-chat";
  organizationId: string;
  target: GoogleChatOutputContext;
  event: GoogleChatMergeData;
}

export function createGoogleChatTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  client: GoogleChatBotClient;
  billingUrlForOrganization?: (organizationId: string) => Promise<string>;
}): TriggerProvider<
  "google-chat",
  GoogleChatTriggerContext,
  GoogleChatOutputContext,
  GoogleChatMaterializedContext
> {
  return {
    name: "google-chat",
    eventNames: ["google-chat.mention"],
    async match(externalTrigger) {
      const event = NormalizedGoogleChatMentionEventSchema.parse(externalTrigger.payload);
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (
        !stored.configuration.triggers.some((candidate) => candidate.on === externalTrigger.source)
      ) {
        return "no_trigger_for_source";
      }

      const matchedTriggers = matchGoogleChatTriggers(
        stored.configuration,
        event,
        externalTrigger.connectionId,
      );
      if (matchedTriggers.length === 0) return "trigger_filters_rejected";

      const matches: TriggerProviderMatch<GoogleChatTriggerContext, GoogleChatOutputContext>[] = [];
      for (const match of matchedTriggers) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiledTrigger === undefined) {
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
        }
        const outputContext: GoogleChatOutputContext = {
          provider: "google-chat",
          projectId: event.projectId,
          spaceName: event.spaceName,
          threadName: event.threadName,
          messageName: event.messageName,
        };
        const triggerContext: GoogleChatTriggerContext = {
          provider: "google-chat",
          organizationId: externalTrigger.organizationId,
          target: outputContext,
          event: buildGoogleChatMergeData(event, externalTrigger.connectionId),
        };
        const invocation = parseInvocation(
          event.text,
          compiledTrigger.inputs,
          undefined,
          readGoogleChatInvocationParserMessage(event, compiledTrigger.filters),
        );
        if (
          invocation.status === "accepted" &&
          !matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)
        ) {
          continue;
        }
        const conversation = {
          key: buildGoogleChatConversationKey(event),
          label: event.spaceType === "dm" ? "Google Chat direct message" : "Google Chat thread",
        };
        if (invocation.status === "rejected") {
          matches.push({
            conversation,
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
          conversation,
          triggerName: match.trigger.name,
          triggerContext,
          outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
          invocation,
        });
      }

      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },

    async materializeContext(launch): Promise<GoogleChatMaterializedContext> {
      const locator = launch.triggerContext.event.google_chat.trigger_thread_context;
      if (locator.status === "not_applicable") {
        return { google_chat: { thread: { status: "not_applicable", messages: [] } } };
      }

      try {
        const result = await options.client.readThreadMessages({
          spaceName: locator.space.name,
          threadName: locator.thread.name,
          beforeMessageName: locator.before.message_name,
          beforeCreatedAt: locator.before.created_at,
        });
        if (result.status === "unavailable") {
          return { google_chat: { thread: { status: "unavailable", messages: [] } } };
        }
        return {
          google_chat: {
            thread: {
              status: "available",
              messages: result.messages.map(toMergeMessage),
            },
          },
        };
      } catch (error) {
        reportFailure(
          error,
          {
            operation: "google-chat.thread.hydrate",
            component: "triggers",
            provider: "google-chat",
          },
          {
            diagnostic: {
              spaceName: locator.space.name,
              threadName: locator.thread.name,
            },
          },
        );
        return { google_chat: { thread: { status: "unavailable", messages: [] } } };
      }
    },

    async onAgentExecutionFailed(triggerContext, _outputContext, reason) {
      await postThreadNoticeSafely(
        options.client,
        triggerContext.target,
        await agentFailureNotice(
          reason,
          triggerContext.organizationId,
          options.billingUrlForOrganization ?? missingBillingUrl,
        ),
      );
      return null;
    },

    async onMachineTerminated(triggerContext, reason, reactionState) {
      if (reason === "launch_failed" || reason === "daemon_disconnected") {
        await postThreadNoticeSafely(
          options.client,
          triggerContext.target,
          `Paseo machine terminated before the agent could complete: ${reason}`,
        );
        return null;
      }
      return reactionState;
    },
  };
}

function buildGoogleChatConversationKey(event: NormalizedGoogleChatMentionEvent): string {
  const scope =
    event.spaceType === "dm" ? event.spaceName : (event.threadName ?? event.messageName);
  return JSON.stringify(["google-chat", event.projectId, scope]);
}

function buildGoogleChatMergeData(
  event: NormalizedGoogleChatMentionEvent,
  connectionId: string | null | undefined,
): GoogleChatMergeData {
  return {
    google_chat: {
      event_type: event.type,
      connection_id: connectionId ?? null,
      project: { id: event.projectId },
      space: {
        name: event.spaceName,
        display_name: event.spaceDisplayName,
        type: event.spaceType,
      },
      trigger_message: {
        id: event.messageName,
        content: event.text,
        body: readGoogleChatPromptBody(event),
        author: {
          id: event.author.id,
          display_name: event.author.displayName,
          email: event.author.email,
          ...(event.author.bot === undefined ? {} : { bot: event.author.bot }),
        },
        space: { name: event.spaceName },
        created_at: event.createdAt,
        thread: event.threadName === null ? null : { name: event.threadName },
      },
      trigger_thread_context:
        event.threadName === null
          ? { status: "not_applicable" }
          : {
              status: "deferred",
              space: { name: event.spaceName },
              thread: { name: event.threadName },
              before: {
                message_name: event.messageName,
                created_at: event.createdAt,
              },
            },
    },
  };
}

function toMergeMessage(message: NormalizedGoogleChatContextMessage): GoogleChatMergeMessage {
  return {
    id: message.id,
    content: message.text,
    author: {
      id: message.author.id,
      display_name: message.author.displayName,
      email: message.author.email,
      ...(message.author.bot === undefined ? {} : { bot: message.author.bot }),
    },
    space: { name: message.spaceName },
    created_at: message.createdAt,
  };
}

async function postThreadNoticeSafely(
  client: GoogleChatBotClient,
  target: GoogleChatOutputContext,
  text: string,
): Promise<void> {
  try {
    await client.sendMessage({
      spaceName: target.spaceName,
      threadName: target.threadName,
      text,
    });
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "google-chat.notice.post",
        component: "triggers",
        provider: "google-chat",
      },
      {
        diagnostic: {
          spaceName: target.spaceName,
          threadName: target.threadName,
        },
      },
    );
  }
}
