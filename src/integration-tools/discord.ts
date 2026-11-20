import { z } from "zod";
import type { Database } from "../db/types.js";
import { discordLatest, discordPost, discordRead } from "./contracts.js";
import { discordId, type IntegrationToolGrant } from "./grants.js";
import {
  IntegrationHttpError,
  IntegrationToolError,
  ownedConnection,
  providerHttp,
  requireChannel,
  type IntegrationToolHandler,
} from "./http.js";

const Channel = z.object({
  id: discordId,
  guild_id: discordId.optional(),
  parent_id: discordId.nullish(),
  name: z.string(),
  type: z.number(),
  thread_metadata: z.object({ archived: z.boolean() }).optional(),
});
type Channel = z.infer<typeof Channel>;

const Message = z.looseObject({
  id: discordId,
  channel_id: discordId,
  timestamp: z.string(),
  flags: z.number().optional(),
});
type Message = z.infer<typeof Message>;
const Messages = z.array(Message);
const Threads = z.object({ threads: z.array(Channel), has_more: z.boolean().optional() });
const TEXT = 0;
const ANNOUNCEMENT = 5;
const PRIVATE_THREAD = 12;
const FORUM = 15;
const MEDIA = 16;
const HAS_THREAD = 1 << 5;
const ARCHIVED_THREADS_PER_CHANNEL = 10;

function isThread(channel: Channel) {
  return [10, 11, PRIVATE_THREAD].includes(channel.type);
}

function isForum(channel: Channel) {
  return channel.type === FORUM || channel.type === MEDIA;
}

function isText(channel: Channel) {
  return channel.type === TEXT || channel.type === ANNOUNCEMENT;
}

function targetIds(guild: string, target: string, message?: string) {
  if (discordId.safeParse(target).success) return { channel: target, message };
  const url =
    /^https:\/\/(?:(?:ptb|canary|www)\.)?discord\.com\/channels\/([0-9]+)\/([0-9]+)(?:\/([0-9]+))?\/?$/u.exec(
      target,
    );
  if (
    !url ||
    url[1] !== guild ||
    !discordId.safeParse(url[2]).success ||
    (url[3] !== undefined &&
      (!discordId.safeParse(url[3]).success || (message !== undefined && url[3] !== message)))
  ) {
    throw new IntegrationToolError("Use a Discord target within the granted server.");
  }
  return { channel: url[2]!, message: url[3] ?? message };
}

export function createDiscordIntegrationTools(
  database: Database,
  appId: string,
  token: string,
  request: typeof fetch = fetch,
): IntegrationToolHandler {
  return async ({ name, organizationId, grant, args }) => {
    const connection = await ownedConnection(
      database,
      "discord",
      appId,
      organizationId,
      grant.connection,
    );
    const api = providerHttp("https://discord.com/api/v10", `Bot ${token}`, request);
    const discord = scopedDiscord(api, discordId.parse(connection.guildId), grant);
    switch (name) {
      case "discord_list_channels":
        return { channels: await discord.channels() };
      case "discord_read":
        return discord.read(discordRead.parse(args));
      case "discord_latest":
        return discord.latest(discordLatest.parse(args));
      case "discord_post":
        return discord.post(discordPost.parse(args));
      default:
        throw new IntegrationToolError("Unknown Discord tool.");
    }
  };
}

function scopedDiscord(
  api: ReturnType<typeof providerHttp>,
  guild: string,
  grant: IntegrationToolGrant,
) {
  function messageUrl(channel: string, message: string) {
    return `https://discord.com/channels/${guild}/${channel}/${message}`;
  }

  function describeMessage(message: Message) {
    return { ...message, url: messageUrl(message.channel_id, message.id) };
  }

  async function getChannel(id: string) {
    const channel = await api(`/channels/${id}`, Channel);
    if (channel.id !== id || channel.guild_id !== guild) {
      throw new IntegrationToolError(
        "The channel or thread is outside the granted Discord server.",
      );
    }
    return channel;
  }

  async function baseChannel(id: string) {
    requireChannel(grant, id);
    const channel = await getChannel(id);
    if (!isText(channel) && !isForum(channel)) {
      throw new IntegrationToolError("Grant Discord text channels or forums by their channel IDs.");
    }
    return channel;
  }

  async function scopedChannel(id: string) {
    if (grant.channels.includes(id)) {
      const channel = await baseChannel(id);
      return { channel, parent: channel };
    }
    const channel = await getChannel(id);
    if (!isThread(channel) || !channel.parent_id) {
      throw new IntegrationToolError("The channel or thread is outside this execution's grant.");
    }
    return { channel, parent: await baseChannel(channel.parent_id) };
  }

  async function getMessage(channel: string, id: string) {
    const message = await api(`/channels/${channel}/messages/${id}`, Message);
    if (message.channel_id !== channel || message.id !== id) {
      throw new IntegrationToolError("Discord returned a message outside the requested channel.");
    }
    return message;
  }

  async function history(channel: string, limit: number, before?: string) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) params.set("before", before);
    const messages = await api(`/channels/${channel}/messages?${params}`, Messages);
    if (messages.some((message) => message.channel_id !== channel)) {
      throw new IntegrationToolError("Discord returned messages outside the requested channel.");
    }
    return messages;
  }

  async function activeThreads() {
    return (await api(`/guilds/${guild}/threads/active`, Threads)).threads;
  }

  function belongsTo(thread: Channel, parent: Channel) {
    return (
      isThread(thread) &&
      thread.parent_id === parent.id &&
      (thread.guild_id === undefined || thread.guild_id === guild)
    );
  }

  async function recentThreads(parent: Channel, active: Channel[]) {
    const publicThreads = await api(
      `/channels/${parent.id}/threads/archived/public?limit=${ARCHIVED_THREADS_PER_CHANNEL}`,
      Threads,
    );
    const privateThreads =
      parent.type === TEXT
        ? await api(
            `/channels/${parent.id}/users/@me/threads/archived/private?limit=${ARCHIVED_THREADS_PER_CHANNEL}`,
            Threads,
          ).catch((error: unknown) => {
            if (
              error instanceof IntegrationHttpError &&
              (error.status === 403 || error.status === 404)
            )
              return { threads: [], has_more: false };
            throw error;
          })
        : { threads: [], has_more: false };
    const threads = [...active, ...publicThreads.threads, ...privateThreads.threads].filter(
      (thread) => belongsTo(thread, parent),
    );
    return {
      threads: [...new Map(threads.map((thread) => [thread.id, thread])).values()],
      moreArchivedThreads: Boolean(publicThreads.has_more || privateThreads.has_more),
    };
  }

  async function threadOnMessage(parent: Channel, message: Message) {
    if (((message.flags ?? 0) & HAS_THREAD) === 0) return undefined;
    const thread = await getChannel(message.id);
    if (!belongsTo(thread, parent))
      throw new IntegrationToolError("The message thread is outside the requested channel.");
    return thread;
  }

  async function readThread(channel: Channel, parent: Channel, limit: number, before?: string) {
    const starter = await getMessage(isForum(parent) ? channel.id : parent.id, channel.id).catch(
      (error: unknown) => {
        if (error instanceof IntegrationHttpError && error.status === 404) return undefined;
        throw error;
      },
    );
    const page = await history(channel.id, limit, before);
    const messages = page
      .filter((message) => message.id !== starter?.id)
      .toReversed()
      .map(describeMessage);
    const nextBefore = page.length === limit ? page.at(-1)?.id : undefined;
    return {
      channel,
      parent,
      starter: starter ? describeMessage(starter) : null,
      messages,
      nextBefore: nextBefore ?? null,
    };
  }

  return {
    async channels() {
      return Promise.all(grant.channels.map(baseChannel));
    },
    async read({ target, message, limit = 100, before }: z.infer<typeof discordRead>) {
      const ids = targetIds(guild, target, message);
      const { channel, parent } = await scopedChannel(ids.channel);
      if (isForum(channel)) {
        if (ids.message !== undefined) {
          const thread = await getChannel(ids.message);
          if (!belongsTo(thread, channel))
            throw new IntegrationToolError("The post is outside the requested forum.");
          return readThread(thread, channel, limit, before);
        }
        return { channel, ...(await recentThreads(channel, await activeThreads())) };
      }
      const exact =
        ids.message === undefined ? undefined : await getMessage(channel.id, ids.message);
      if (isThread(channel)) {
        return {
          ...(await readThread(channel, parent, limit, before)),
          message: exact && describeMessage(exact),
        };
      }
      if (exact) {
        const thread = await threadOnMessage(channel, exact);
        return {
          channel,
          message: describeMessage(exact),
          thread: thread && (await readThread(thread, channel, limit, before)),
        };
      }
      const messages = await history(channel.id, limit, before);
      return {
        channel,
        messages: messages.map(describeMessage),
        nextBefore: messages.length === limit ? messages.at(-1)?.id : null,
      };
    },
    async latest({ channel, limit = 20 }: z.infer<typeof discordLatest>) {
      const parents = await Promise.all(
        (channel === undefined ? grant.channels : [channel]).map(baseChannel),
      );
      const active = await activeThreads();
      const messages: Message[] = [];
      let moreArchivedThreads = false;
      for (const parent of parents) {
        if (isText(parent)) messages.push(...(await history(parent.id, limit)));
        const recent = await recentThreads(parent, active);
        moreArchivedThreads ||= recent.moreArchivedThreads;
        for (const thread of recent.threads) {
          messages.push(...(await history(thread.id, limit)));
        }
      }
      messages.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
      return { messages: messages.slice(0, limit).map(describeMessage), moreArchivedThreads };
    },
    async post({ target, message, content, threadName }: z.infer<typeof discordPost>) {
      const ids = targetIds(guild, target, message);
      const { channel } = await scopedChannel(ids.channel);
      if (isForum(channel) && ids.message === undefined) {
        throw new IntegrationToolError("Choose a post within this forum.");
      }
      let destination = channel;
      if (isForum(channel)) {
        destination = await getChannel(ids.message!);
        if (!belongsTo(destination, channel))
          throw new IntegrationToolError("The post is outside the requested forum.");
      } else if (ids.message !== undefined) {
        const exact = await getMessage(channel.id, ids.message);
        if (isText(channel)) {
          destination =
            (await threadOnMessage(channel, exact)) ??
            (await api(`/channels/${channel.id}/messages/${exact.id}/threads`, Channel, {
              name: threadName ?? `Reply to ${exact.id}`,
            }));
          if (destination.id !== exact.id || !belongsTo(destination, channel)) {
            throw new IntegrationToolError("The message thread is outside the requested channel.");
          }
        }
      }
      const posted = await api(`/channels/${destination.id}/messages`, Message, {
        content,
        allowed_mentions: { parse: [], replied_user: false },
        ...(isThread(channel) && ids.message !== undefined
          ? {
              message_reference: {
                message_id: ids.message,
                channel_id: channel.id,
                fail_if_not_exists: true,
              },
            }
          : {}),
      });
      if (posted.channel_id !== destination.id)
        throw new IntegrationToolError("Discord did not confirm the destination.");
      // Discord's send response can include the referenced message, which requires read access.
      return {
        channelId: destination.id,
        messageId: posted.id,
        url: messageUrl(destination.id, posted.id),
      };
    },
  };
}
