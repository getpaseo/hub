import { z } from "zod";

const SlackApiResponseSchema = z
  .object({ ok: z.boolean(), error: z.string().optional() })
  .passthrough();
const SLACK_API_TIMEOUT_MS = 10_000;

export interface SlackBotClient {
  sendMessage(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    content: string;
  }): Promise<void>;
  addReaction(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    name: string;
  }): Promise<void>;
  removeReaction(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    name: string;
  }): Promise<void>;
}

export function createSlackBotClient(options: {
  tokenForWorkspace(organizationId: string, teamId: string): Promise<string | undefined>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}): SlackBotClient {
  const request = options.fetch ?? fetch;

  async function call(
    organizationId: string,
    teamId: string,
    method: string,
    body: Record<string, string>,
  ): Promise<void> {
    const token = await options.tokenForWorkspace(organizationId, teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const response = await request(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    const result = SlackApiResponseSchema.parse(await response.json());
    if (!result.ok) throw new Error(`Slack API ${result.error ?? "unknown_error"}`);
  }

  return {
    sendMessage: (input) =>
      call(input.organizationId, input.teamId, "chat.postMessage", {
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: input.content,
      }),
    addReaction: (input) =>
      call(input.organizationId, input.teamId, "reactions.add", {
        channel: input.channelId,
        timestamp: input.messageTs,
        name: input.name,
      }),
    removeReaction: (input) =>
      call(input.organizationId, input.teamId, "reactions.remove", {
        channel: input.channelId,
        timestamp: input.messageTs,
        name: input.name,
      }),
  };
}
