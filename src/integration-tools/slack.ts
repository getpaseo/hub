import { z } from "zod";
import type { Database } from "../db/types.js";
import { slackPost, slackRead, slackThreadTs } from "./contracts.js";
import {
  IntegrationToolError,
  ownedConnection,
  providerHttp,
  requireChannel,
  type IntegrationToolHandler,
} from "./http.js";

const Status = z.object({ ok: z.boolean() });
const Message = z.looseObject({ ts: slackThreadTs, thread_ts: slackThreadTs.optional() });
const History = Status.extend({
  messages: z.array(Message).optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
  has_more: z.boolean().optional(),
});
const Posted = Status.extend({ channel: z.string().optional(), ts: slackThreadTs.optional() });

export function createSlackIntegrationTools(
  database: Database,
  appId: string,
  request: typeof fetch = fetch,
): IntegrationToolHandler {
  return async ({ name, organizationId, grant, args }) => {
    const connection = await ownedConnection(
      database,
      "slack",
      appId,
      organizationId,
      grant.connection,
    );
    const api = providerHttp(
      "https://slack.com/api/",
      `Bearer ${connection.botAccessToken}`,
      request,
    );
    if (name === "slack_list_channels") {
      return { channels: grant.channels.map((id) => ({ id })) };
    }
    if (name === "slack_read") {
      const input = slackRead.parse(args);
      requireChannel(grant, input.channel);
      return readSlack(api, input);
    }
    if (name === "slack_post") {
      const input = slackPost.parse(args);
      requireChannel(grant, input.channel);
      return postSlack(api, input);
    }
    throw new IntegrationToolError("Unknown Slack tool.");
  };
}

async function readSlack(
  api: ReturnType<typeof providerHttp>,
  { channel, thread_ts, limit = 20, cursor }: z.infer<typeof slackRead>,
) {
  const params = new URLSearchParams({ channel, limit: String(limit) });
  if (thread_ts !== undefined) params.set("ts", thread_ts);
  if (cursor !== undefined) params.set("cursor", cursor);
  const method = thread_ts === undefined ? "conversations.history" : "conversations.replies";
  const history = await api(`${method}?${params}`, History);
  if (!history.ok || !history.messages) {
    throw new IntegrationToolError(
      "Slack could not read this channel or thread. Check the ID and bot permissions.",
    );
  }
  if (
    thread_ts !== undefined &&
    ((cursor === undefined && history.messages[0]?.ts !== thread_ts) ||
      history.messages.some((message) => (message.thread_ts ?? message.ts) !== thread_ts))
  ) {
    throw new IntegrationToolError("Slack did not return messages from the requested thread.");
  }
  return {
    channel,
    messages: history.messages,
    nextCursor: history.response_metadata?.next_cursor || null,
    hasMore: history.has_more ?? false,
  };
}

async function postSlack(
  api: ReturnType<typeof providerHttp>,
  { channel, thread_ts, content }: z.infer<typeof slackPost>,
) {
  if (thread_ts !== undefined) {
    // Ask Slack for the exact top-level message within the granted channel before posting.
    const params = new URLSearchParams({
      channel,
      latest: thread_ts,
      inclusive: "true",
      limit: "1",
    });
    const history = await api(`conversations.history?${params}`, History);
    const parent = history.messages?.[0];
    if (!history.ok || parent?.ts !== thread_ts || (parent.thread_ts ?? parent.ts) !== thread_ts) {
      throw new IntegrationToolError(
        "The thread starter was not found in the granted Slack channel.",
      );
    }
  }
  const posted = await api("chat.postMessage", Posted, {
    channel,
    text: content,
    unfurl_links: false,
    unfurl_media: false,
    ...(thread_ts === undefined ? {} : { thread_ts }),
  });
  if (!posted.ok || posted.channel !== channel || posted.ts === undefined) {
    throw new IntegrationToolError(
      "Slack did not confirm the message. Check the channel and bot permissions.",
    );
  }
  return { channel, ts: posted.ts };
}
