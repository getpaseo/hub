import assert from "node:assert/strict";
import { REST } from "discord.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { describe, it } from "vitest";
import { z } from "zod";
import { hashAgentExecutionCompletionToken } from "../agent-executions/completion-token.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { buildLaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import {
  createDiscordIntegrationTools,
  createSlackIntegrationTools,
} from "../integration-tools/index.js";
import type { IntegrationToolGrants } from "../integration-tools/grants.js";
import {
  chat,
  localChatFetch,
  seedChatConnections,
  startFakeChat,
} from "../test-utils/fake-chat.js";
import { OutputExecutorRegistry, executionToolDefinitions } from "./outputs.js";
import { createExecutionCapabilityServer } from "./server.js";
import { executionToolPolicy } from "./tool-policy.js";

const grants: IntegrationToolGrants = {
  slack: { connection: "test-slack", actions: ["read", "post"], channels: [chat.slack.channel] },
  discord: {
    connection: "test-discord",
    actions: ["read", "post"],
    channels: [chat.discord.forum, chat.discord.text, chat.discord.otherGuildChannel],
  },
};
const RpcResult = z.object({
  result: z.union([
    z.object({
      tools: z.array(
        z.object({
          name: z.string(),
          inputSchema: z.object({ required: z.array(z.string()).optional() }),
        }),
      ),
    }),
    z.object({
      isError: z.boolean().optional(),
      content: z.tuple([z.object({ text: z.string() })]),
    }),
  ]),
});

describe("Scoped integration tools through Hub MCP", () => {
  it("preapproves the same tools the endpoints advertise", () => {
    const policy = executionToolPolicy({
      allowOutputs: [],
      outputContext: null,
      tools: {
        slack: { ...grants.slack!, actions: ["post"] },
        discord: { ...grants.discord!, actions: ["read"] },
      },
      capabilities: new OutputExecutorRegistry(),
    });
    assert.deepEqual(
      policy.preapproved?.map((entry) => entry.kind === "mcp" && entry.tool),
      ["finish_execution", "slack_post", "discord_list_channels", "discord_read", "discord_latest"],
    );
  });

  it("uses server-owned credentials and rejects targets and actions outside each execution's grant", async () => {
    await mkdir(".artifacts", { recursive: true });
    const directory = await mkdtemp(".artifacts/integration-db-");
    const { runtime, locks } = await embeddedDatabaseRuntime(directory);
    const database = createDatabase(runtime, locks);
    const fake = await startFakeChat({
      deletedThreadDuringScan: true,
      loseFirstReferencedPostResponse: true,
      threadCreationRace: true,
      rateLimitActiveThreads: true,
    });
    try {
      await runtime.migrate();
      await runtime.query(
        "insert into organization (id, name, slug) values ('owner', 'Owner', 'owner'), ('other', 'Other', 'other')",
      );
      await runtime.query(
        `insert into "user" (id, name, email) values ('user', 'User', 'user@example.test')`,
      );
      await runtime.query(
        `insert into member (id, organization_id, user_id, role) values ('owner-member', 'owner', 'user', 'owner'), ('other-member', 'other', 'user', 'owner')`,
      );
      await seedChatConnections(runtime, "owner", "user");
      async function createProject(organizationId: string) {
        const project = await database.createProject({
          organizationId,
          name: "Test",
          slug: "test",
          createdByUserId: "user",
        });
        const revisionId = randomUUID();
        await runtime.query(
          `insert into project_configuration_revisions
            (id, project_id, organization_id, version, source_kind, source_evidence, normalized_configuration, content_hash)
           values ($1, $2, $3, 1, 'manual', '{}', '{}', 'test')`,
          [revisionId, project.id, organizationId],
        );
        return { project, revisionId };
      }
      const owner = await createProject("owner");
      const other = await createProject("other");
      const sessionId = randomUUID();
      const token = "mcp-token";
      const tokenHash = hashAgentExecutionCompletionToken(token);
      const outputs = new OutputExecutorRegistry();
      const upstreamFetch = localChatFetch(fake.origin);
      const server = createExecutionCapabilityServer({
        database,
        outputs,
        completionTokenSecret: "test-secret",
        integrationTools: {
          slack: createSlackIntegrationTools(database, chat.slack.appId, upstreamFetch),
          discord: createDiscordIntegrationTools(
            database,
            chat.discord.appId,
            new REST({ api: `${fake.origin}/api`, retries: 1 }).setToken(chat.discord.token),
          ),
        },
        completeExecution: async ({ executionId }) =>
          (await database.transitionAgentExecution(executionId, "succeeded")).execution,
      });
      async function insertExecution(organizationId: string, tools: IntegrationToolGrants) {
        const id = randomUUID();
        const { project, revisionId } = organizationId === "owner" ? owner : other;
        await database.insertAgentExecution({
          id,
          organizationId,
          projectId: project.id,
          configurationRevisionId: revisionId,
          completionTokenHash: tokenHash,
          launchIntent: buildLaunchMachineIntent({
            organizationId,
            projectId: project.id,
            triggerRunId: randomUUID(),
            configurationRevisionId: revisionId,
            triggerName: "test-schedule",
            environmentName: "runner",
            environment: {
              kind: "daemon",
              daemonId: randomUUID(),
              authoredSlug: "runner",
              cwd: "/tmp",
            },
            prompt: "Check MCP tools",
            agent: { provider: "codex" },
            allowOutputs: [],
            autoArchive: false,
            background: false,
            triggerContext: null,
            outputContext: null,
            hubConfig: {},
            tools,
          }),
          machineId: null,
          triggerContext: null,
          outputContext: null,
        });
        return id;
      }
      const executionId = await insertExecution("owner", grants);
      const otherId = await insertExecution("other", grants);
      const readOnlyId = await insertExecution("owner", {
        discord: {
          ...grants.discord!,
          actions: ["read"],
          channels: [chat.discord.forum, chat.discord.text],
        },
      });
      await database.saveAgentSession({
        id: sessionId,
        organizationId: "owner",
        projectId: owner.project.id,
        daemonId: randomUUID(),
        continuationKey: "follow-up",
        agentId: null,
        workspaceId: null,
        compatibility: "current",
        creationOptions: {
          provider: "codex",
          cwd: "/tmp",
          env: {},
          toolPolicy: { preapproved: [] },
        },
        capabilityTokenHash: tokenHash,
        tools: executionToolDefinitions(undefined, [], grants),
      });
      await database.attachExecutionToSession(executionId, sessionId);
      await database.attachExecutionToSession(readOnlyId, sessionId);

      async function rpc(method: string, params: unknown, session = false, id = executionId) {
        const request = new Request("https://hub.test/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const response = session
          ? await server.handleSession(request, sessionId)
          : await server.handle(request, id);
        assert.equal(response.status, 200);
        const parsed = RpcResult.parse(await response.json());
        return parsed.result;
      }
      async function call(
        name: string,
        args: Record<string, unknown>,
        session = false,
        id = executionId,
      ) {
        const result = await rpc(
          "tools/call",
          { name, arguments: { ...args, ...(session ? { executionId: id } : {}) } },
          session,
          id,
        );
        assert("content" in result);
        assert(
          !result.content[0].text.includes(chat.slack.token) &&
            !result.content[0].text.includes(chat.discord.token),
        );
        return { ok: result.isError !== true, output: result.content[0].text };
      }

      const listed = await rpc("tools/list", {});
      const sessionListed = await rpc("tools/list", {}, true);
      assert("tools" in listed && "tools" in sessionListed);
      assert.deepEqual(
        listed.tools.map(({ name }) => name),
        sessionListed.tools.map(({ name }) => name),
      );
      assert(
        sessionListed.tools.every(({ inputSchema }) =>
          inputSchema.required?.includes("executionId"),
        ),
      );
      const denied = await call("slack_post", { channel: chat.slack.denied, content: "deny" });
      assert.match(denied.output, /outside this execution's grant/u);
      assert.equal((await call("slack_list_channels", {}, false, otherId)).ok, false);
      assert.equal(
        (
          await call(
            "discord_post",
            { target: chat.discord.thread, content: "deny" },
            true,
            readOnlyId,
          )
        ).ok,
        false,
      );
      assert.equal(
        (await call("discord_read", { target: chat.discord.forum }, true, otherId)).ok,
        false,
      );
      assert.equal(fake.calls.length, 0);
      const slackChannels = await call("slack_list_channels", {});
      assert.deepEqual(JSON.parse(slackChannels.output), {
        channels: [{ id: chat.slack.channel }],
      });
      const slackRead = await call("slack_read", {
        channel: chat.slack.channel,
        thread_ts: chat.slack.thread,
      });
      assert.match(slackRead.output, /Slack reply/u);
      assert.equal(
        (
          await call("slack_read", {
            channel: chat.slack.channel,
            thread_ts: chat.slack.deniedThread,
          })
        ).ok,
        false,
      );
      assert.equal(
        (
          await call("slack_post", {
            channel: chat.slack.channel,
            thread_ts: chat.slack.deniedThread,
            content: "deny",
          })
        ).ok,
        false,
      );
      assert.equal(
        (
          await call(
            "slack_post",
            { channel: chat.slack.channel, thread_ts: chat.slack.thread, content: "allowed" },
            true,
          )
        ).ok,
        true,
      );
      assert.equal(fake.calls.filter(({ path }) => path === "/api/chat.postMessage").length, 1);

      const discordChannels = await call("discord_list_channels", {}, true, readOnlyId);
      assert(discordChannels.ok);
      assert.match(discordChannels.output, /channel-100/u);
      assert.doesNotMatch(discordChannels.output, /channel-200/u);
      const discordRead = await call(
        "discord_read",
        {
          target: `https://discord.com/channels/${chat.discord.guild}/${chat.discord.thread}/${chat.discord.reply}`,
        },
        true,
        readOnlyId,
      );
      assert(discordRead.ok);
      assert.match(discordRead.output, /report.txt/u);
      assert.match(discordRead.output, /Test Reporter/u);
      assert.match(discordRead.output, /"reactions"/u);
      assert.match(discordRead.output, /"embeds"/u);
      assert.match(discordRead.output, /discord\.com\/channels\/900\/110\/111/u);
      const scanId = await insertExecution("owner", {
        discord: {
          connection: "test-discord",
          actions: ["read"],
          channels: [chat.discord.forum, "101", "102", chat.discord.text],
        },
      });
      const latest = await call("discord_latest", {}, false, scanId);
      assert.match(latest.output, /Archived report/u);
      assert.match(latest.output, /Thread reply/u);
      assert.match(latest.output, /"skippedThreads":1/u);
      assert.match(latest.output, /Standalone question/u);
      assert.match(latest.output, /"scannedChannels":\["100","300"\]/u);
      assert.match(latest.output, /"unavailableChannels":\["101","102"\]/u);
      assert.match(latest.output, /"timedOut":false/u);
      assert.equal(
        fake.calls.filter(({ path }) => path === "/api/v10/guilds/900/threads/active").length,
        2,
      );
      assert.equal((await call("discord_read", { target: chat.discord.otherThread })).ok, false);
      assert.equal(
        (await call("discord_read", { target: chat.discord.otherGuildChannel })).ok,
        false,
      );
      assert.equal(
        (await call("discord_post", { target: chat.discord.otherThread, content: "deny" })).ok,
        false,
      );
      assert.equal(
        (
          await call("discord_post", {
            target: chat.discord.forum,
            message: chat.discord.otherThread,
            content: "deny",
          })
        ).ok,
        false,
      );
      assert(!fake.calls.some(({ path }) => path.startsWith("/api/v10/channels/210/messages")));
      const postOnlyId = await insertExecution("owner", {
        discord: { connection: "test-discord", actions: ["post"], channels: [chat.discord.forum] },
      });
      await database.attachExecutionToSession(postOnlyId, sessionId);
      const posted = await call(
        "discord_post",
        {
          target: chat.discord.thread,
          message: chat.discord.reply,
          content: "@everyone <@&123>",
        },
        true,
        postOnlyId,
      );
      assert(posted.ok);
      assert.deepEqual(JSON.parse(posted.output), {
        channelId: chat.discord.thread,
        messageId: "995",
        url: "https://discord.com/channels/900/110/995",
      });
      assert.equal(
        (
          await call("discord_post", {
            target: chat.discord.text,
            message: chat.discord.starter,
            threadName: "Follow up",
            content: "Contextual reply",
          })
        ).ok,
        true,
      );
      assert.equal(
        (
          await call("discord_post", {
            target: chat.discord.text,
            message: chat.discord.starter,
            content: "Next reply",
          })
        ).ok,
        true,
      );
      const attempts = fake.calls.filter(
        ({ method, path }) => method === "POST" && path === "/api/v10/channels/110/messages",
      );
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0], attempts[1]);
      assert.deepEqual(
        fake.discordWrites().filter((_write, index) => index !== 1),
        [
          {
            method: "POST",
            path: "/api/v10/channels/110/messages",
            body: {
              content: "@everyone <@&123>",
              allowed_mentions: { parse: [], replied_user: false },
              message_reference: { message_id: "111", channel_id: "110", fail_if_not_exists: true },
            },
          },
          {
            method: "POST",
            path: "/api/v10/channels/300/messages/310/threads",
            body: { name: "Follow up" },
          },
          {
            method: "POST",
            path: "/api/v10/channels/310/messages",
            body: {
              content: "Contextual reply",
              allowed_mentions: { parse: [], replied_user: false },
            },
          },
          {
            method: "POST",
            path: "/api/v10/channels/310/messages",
            body: { content: "Next reply", allowed_mentions: { parse: [], replied_user: false } },
          },
        ],
      );
      const callCount = fake.calls.length;
      await runtime.query("delete from slack_connections where organization_id = 'owner'");
      assert.equal(
        (await call("slack_post", { channel: chat.slack.channel, content: "Disconnected" })).ok,
        false,
      );
      await runtime.query(
        "update discord_connections set provider_application_id = 'different-app' where organization_id = 'owner'",
      );
      assert.equal((await call("discord_list_channels", {}, true)).ok, false);
      assert.equal(fake.calls.length, callCount);

      await database.transitionAgentExecution(executionId, "succeeded");
      assert.equal((await call("discord_read", { target: chat.discord.thread }, true)).ok, false);
    } finally {
      await fake.close();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
