import assert from "node:assert/strict";
import { createFetchServer } from "../http/node-server.js";
import type { QueryHandle } from "../db/runtime/index.js";

export const chat = {
  slack: {
    appId: "ATEST",
    token: "fake-slack-token",
    channel: "CALLOWED",
    denied: "CFORBIDDEN",
    thread: "1000000000.000001",
    deniedThread: "1000000000.000002",
  },
  discord: {
    appId: "800",
    token: "fake-discord-token",
    guild: "900",
    forum: "100",
    thread: "110",
    archived: "120",
    reply: "111",
    otherForum: "200",
    otherThread: "210",
    text: "300",
    starter: "310",
    otherGuild: "999",
    otherGuildChannel: "400",
  },
};

export async function seedChatConnections(
  runtime: QueryHandle,
  organizationId: string,
  userId: string,
) {
  await runtime.query(
    `insert into slack_connections
       (organization_id, team_id, slug, team_name, bot_user_id, bot_access_token, scopes, connected_by_user_id, provider_application_id)
     values ($1, 'TTEST', 'test-slack', 'Test Slack', 'UTEST', $2, '["chat:write","channels:history"]'::jsonb, $3, $4)`,
    [organizationId, chat.slack.token, userId, chat.slack.appId],
  );
  await runtime.query(
    `insert into discord_connections
       (organization_id, guild_id, slug, guild_name, provider_application_id)
     values ($1, $2, 'test-discord', 'Test Discord', $3)`,
    [organizationId, chat.discord.guild, chat.discord.appId],
  );
}

export function localChatFetch(origin: string): typeof fetch {
  return (input, init) => {
    if (typeof input !== "string") throw new Error("Expected a provider URL");
    const upstream = new URL(input);
    if (!["slack.com", "discord.com"].includes(upstream.hostname))
      throw new Error("Unexpected provider host");
    return fetch(new URL(upstream.pathname + upstream.search, origin), init);
  };
}

export async function startFakeChat() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let contextualThread = false;
  const { slack, discord } = chat;
  const channel = (id: string, type: number, parent_id?: string, guild_id = discord.guild) => ({
    id,
    name: `channel-${id}`,
    type,
    guild_id,
    parent_id,
  });
  const message = (channel_id: string, id: string, content: string, extra = {}) => ({
    id,
    channel_id,
    content,
    timestamp: "2026-01-01T00:00:00.000Z",
    author: { id: "990", username: "Test Reporter" },
    ...extra,
  });
  const starter = message(discord.thread, discord.thread, "Report with attachment", {
    attachments: [
      {
        id: "991",
        filename: "report.txt",
        content_type: "text/plain",
        size: 6,
        url: "https://cdn.discordapp.com/attachments/110/991/report.txt",
      },
    ],
    embeds: [{ title: "Report" }],
    reactions: [{ count: 1, emoji: { name: "👍" } }],
  });
  const channels: Record<string, ReturnType<typeof channel>> = {
    [discord.forum]: channel(discord.forum, 15),
    [discord.thread]: channel(discord.thread, 11, discord.forum),
    [discord.archived]: channel(discord.archived, 11, discord.forum),
    [discord.otherForum]: channel(discord.otherForum, 15),
    [discord.otherThread]: channel(discord.otherThread, 11, discord.otherForum),
    [discord.text]: channel(discord.text, 0),
    [discord.otherGuildChannel]: channel(
      discord.otherGuildChannel,
      0,
      undefined,
      discord.otherGuild,
    ),
  };
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body: unknown = request.method === "POST" ? await request.json() : undefined;
    const path = url.pathname;
    const isDiscord = path.startsWith("/api/v10/");
    const authorization = isDiscord ? `Bot ${discord.token}` : `Bearer ${slack.token}`;
    if (request.headers.get("authorization") !== authorization)
      return new Response(null, { status: 401 });
    calls.push({
      method: request.method,
      path: path + url.search,
      ...(body === undefined ? {} : { body }),
    });
    return (
      (isDiscord ? discordResponse(request, url, body) : slackResponse(url, body)) ??
      new Response(null, { status: 404 })
    );
  };

  function slackResponse(url: URL, body: unknown) {
    const path = url.pathname;
    const params = url.searchParams;
    if (path === "/api/conversations.replies" && params.get("channel") === slack.channel) {
      return Response.json(
        params.get("ts") === slack.thread
          ? {
              ok: true,
              messages: [
                { ts: slack.thread, text: "Slack starter" },
                { ts: "1000000001.000001", thread_ts: slack.thread, text: "Slack reply" },
              ],
            }
          : { ok: false, error: "thread_not_found" },
      );
    }
    if (path === "/api/conversations.history" && params.get("channel") === slack.channel) {
      return Response.json({
        ok: true,
        messages:
          params.get("latest") === slack.deniedThread
            ? []
            : [{ ts: slack.thread, text: "Slack starter" }],
      });
    }
    if (
      path === "/api/chat.postMessage" &&
      typeof body === "object" &&
      body !== null &&
      "channel" in body
    ) {
      return Response.json({ ok: true, channel: body.channel, ts: "1000000003.000001" });
    }
    return undefined;
  }

  function discordResponse(request: Request, url: URL, body: unknown): Response | undefined {
    const path = url.pathname;
    if (path === `/api/v10/guilds/${discord.guild}/threads/active`) {
      return Response.json({ threads: [channels[discord.thread], channels[discord.otherThread]] });
    }
    if (path === `/api/v10/channels/${discord.forum}/threads/archived/public`) {
      return Response.json({ threads: [channels[discord.archived]], has_more: false });
    }
    if (path.startsWith(`/api/v10/channels/${discord.text}/`) && path.includes("/archived/")) {
      return Response.json({ threads: [], has_more: false });
    }
    const channelRoute =
      /^\/api\/v10\/channels\/([0-9]+)(?:\/messages(?:\/([0-9]+)(\/threads)?)?)?$/u.exec(path);
    if (!channelRoute) return undefined;
    const [, id, messageId, createThread] = channelRoute;
    assert(id !== undefined);
    if (!path.includes("/messages")) {
      const found = channels[id];
      return found === undefined ? undefined : Response.json(found);
    }
    if (request.method === "POST") return discordWrite(id, messageId, createThread, body);
    return discordMessages(id, messageId);
  }

  function discordWrite(
    id: string,
    messageId: string | undefined,
    createThread: string | undefined,
    body: unknown,
  ) {
    if (createThread !== undefined) {
      if (id !== discord.text || messageId !== discord.starter) return undefined;
      contextualThread = true;
      const created = channel(discord.starter, 11, discord.text);
      channels[created.id] = created;
      return Response.json(created);
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !("content" in body) ||
      typeof body.content !== "string"
    ) {
      return new Response(null, { status: 400 });
    }
    const reference =
      "message_reference" in body
        ? { referenced_message: message(discord.thread, discord.reply, "Thread reply") }
        : {};
    return Response.json(message(id, "995", body.content, reference));
  }

  function discordMessages(id: string, messageId: string | undefined) {
    const reply = message(discord.thread, discord.reply, "Thread reply");
    const question = message(discord.text, discord.starter, "Standalone question", {
      flags: contextualThread ? 32 : 0,
    });
    const history = {
      [discord.thread]: [reply, starter],
      [discord.archived]: [message(discord.archived, discord.archived, "Archived report")],
      [discord.text]: [question],
    }[id];
    if (history === undefined) return undefined;
    if (messageId === undefined) return Response.json(history);
    const exact = history.find((item) => item.id === messageId);
    return exact === undefined ? undefined : Response.json(exact);
  }
  const server = createFetchServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    calls,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
