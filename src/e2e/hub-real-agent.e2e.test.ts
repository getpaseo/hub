import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { chat, startFakeChat } from "../test-utils/fake-chat.js";
import { HubE2E } from "./harness/index.js";

const describeRealAgent = process.env["RUN_HUB_REAL_AGENT_E2E"] === "1" ? describe : describe.skip;

describeRealAgent("Hub execution MCP real-agent smoke", () => {
  let hub: HubE2E;

  beforeEach(async () => {
    hub = await HubE2E.start({ realAgent: true });
  }, 120_000);

  afterEach(async () => {
    const shutdown = await hub?.stop();
    assert.deepEqual(shutdown?.leakedProcesses ?? [], []);
  }, 120_000);

  it("continues a real Codex session after workspace archival", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.enableAgentContinuation(true);
    const first = await hub.runRealAgentManual("real-continuation-first");
    const firstEvidence = await hub.realAgentCompletionEvidence(first, "codex");
    assert.equal(firstEvidence.completedByAgent, true);
    await hub.sessionIsArchived(first.executionId);
    const second = await hub.runRealAgentManual("real-continuation-second");
    assert.equal(second.agentId, first.agentId);
    const secondEvidence = await hub.realAgentCompletionEvidence(second, "codex");
    assert.equal(secondEvidence.status, "succeeded");
    assert.equal(secondEvidence.completedByAgent, true);
    assert.equal(secondEvidence.completedToolCall, true);
  }, 300_000);

  it("lets a real Codex agent finalize a production manual run through MCP", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.installRealAgentConfiguration("codex");

    const run = await hub.runRealAgentManual("real-agent-finalize");
    const evidence = await hub.realAgentCompletionEvidence(run, "codex");

    assert.equal(evidence.status, "succeeded");
    assert.equal(evidence.completedByAgent, true);
    assert.equal(evidence.completedToolCall, true);
    assert.equal(evidence.completionHelperLaunched, false);
  }, 300_000);

  it("lets a real Claude agent finalize a production manual run through MCP", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.installRealAgentConfiguration("claude");

    const run = await hub.runRealAgentManual("real-claude-finalize");
    const evidence = await hub.realAgentCompletionEvidence(run, "claude");

    assert.equal(evidence.status, "succeeded");
    assert.equal(evidence.completedByAgent, true);
    assert.equal(evidence.completedToolCall, true);
    assert.equal(evidence.completionHelperLaunched, false);
  }, 300_000);

  it("lets a permissioned real OpenCode agent finalize through preapproved Hub MCP", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.installRealAgentConfiguration("opencode");

    const run = await hub.runRealAgentManual("real-opencode-finalize");
    const evidence = await hub.realAgentCompletionEvidence(run, "opencode");

    assert.equal(evidence.status, "succeeded");
    assert.equal(evidence.completedByAgent, true);
    assert.equal(evidence.completedToolCall, true);
    assert.equal(evidence.completionHelperLaunched, false);
  }, 300_000);

  it("routes deterministic input and classifier fallback through the real daemon", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.installRealAgentRoutingConfiguration("codex");

    const deterministicRun = await hub.runRealAgentRouting(
      "routing-deterministic",
      "repo=paseo task",
    );
    const deterministic = await hub.realAgentRoutingEvidence(deterministicRun, "codex");
    assert.deepEqual(
      deterministic.steps.map((step) => [step.stepId, step.status]),
      [
        ["classify", "skipped"],
        ["work-paseo", "succeeded"],
        ["work-hub", "skipped"],
      ],
    );

    const classifiedRun = await hub.runRealAgentRouting("routing-classifier", "investigate");
    const classified = await hub.realAgentRoutingEvidence(classifiedRun, "codex");
    assert.deepEqual(
      classified.steps.map((step) => [step.stepId, step.status]),
      [
        ["classify", "succeeded"],
        ["work-paseo", "skipped"],
        ["work-hub", "succeeded"],
      ],
    );
    assert.deepEqual(classified.steps[0]?.output, { repo: "hub" });
  }, 600_000);

  it("routes classifier fallback through a real Claude multi-step workflow", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.installRealAgentRoutingConfiguration("claude");

    const run = await hub.runRealAgentRouting(
      "claude-routing-classifier",
      "investigate Hub workflows",
    );
    const evidence = await hub.realAgentRoutingEvidence(run, "claude");

    assert.deepEqual(
      evidence.steps.map((step) => [step.stepId, step.status]),
      [
        ["classify", "succeeded"],
        ["work-paseo", "skipped"],
        ["work-hub", "succeeded"],
      ],
    );
    assert.deepEqual(evidence.steps[0]?.output, { repo: "hub" });
  }, 600_000);
});

describeRealAgent("scheduled scoped integration tools", () => {
  let hub: HubE2E;
  let fake: Awaited<ReturnType<typeof startFakeChat>>;

  beforeEach(async () => {
    fake = await startFakeChat();
    hub = await HubE2E.start({ realAgent: true, fakeChatOrigin: fake.origin });
    await hub.connect();
    await hub.daemonIsConnected();
  }, 120_000);

  afterEach(async () => {
    try {
      assert.deepEqual((await hub?.stop())?.leakedProcesses ?? [], []);
    } finally {
      await fake?.close();
    }
  }, 120_000);

  it("posts a scheduled Slack digest through scoped MCP", async () => {
    const run = await hub.runScheduledIntegrationTools({
      name: "slack-digest",
      tools: {
        slack: { connection: "test-slack", actions: ["post"], channels: [chat.slack.channel] },
      },
      prompt: `Use only the Hub MCP tools. Test the authorization boundary of the local fake Slack server: first make one slack_post call to channel ${chat.slack.denied} with content "Scope probe" and observe the expected rejection. Then use slack_post to channel ${chat.slack.channel} with exact content "Scheduled digest delivered". Finish with finish_execution. Use the executionId from the prompt when the tools require it.`,
    });
    assert.equal(run.evidence.completedByAgent, true);
    assert.match(JSON.stringify(run.timeline), /outside this execution's grant/u);
    assert.deepEqual(fake.calls, [
      {
        method: "POST",
        path: "/api/chat.postMessage",
        body: {
          channel: chat.slack.channel,
          text: "Scheduled digest delivered",
          unfurl_links: false,
          unfurl_media: false,
        },
      },
    ]);
  }, 300_000);

  it("reads a forum attachment and replies contextually through scheduled Discord MCP", async () => {
    const { discord } = chat;
    const run = await hub.runScheduledIntegrationTools({
      name: "discord-triage",
      continueSession: true,
      tools: {
        discord: {
          connection: "test-discord",
          actions: ["read", "post"],
          channels: [discord.forum],
        },
      },
      prompt: `Use only the Hub MCP tools with the executionId from the prompt. Call discord_list_channels. Read the exact Discord reply https://discord.com/channels/${discord.guild}/${discord.thread}/${discord.reply} using discord_read. Post with discord_post to that reply's URL, with content exactly "Reviewed FILE", substituting the attachment filename from the thread starter for FILE. Then test the local fake server's authorization by calling discord_post once each with targets "${discord.otherForum}" and "${discord.otherThread}", both with content "Scope probe". Expect both to be rejected and finish with finish_execution.`,
    });
    assert.equal(run.evidence.completedByAgent, true);
    assert.match(JSON.stringify(run.timeline), /outside this execution's grant/u);
    assert(fake.calls.some(({ path }) => path === "/api/v10/channels/100"));
    assert(fake.calls.some(({ path }) => path === "/api/v10/channels/110/messages/110"));
    assert(fake.calls.some(({ path }) => path === "/api/v10/channels/200"));
    assert(fake.calls.some(({ path }) => path === "/api/v10/channels/210"));
    assert.deepEqual(fake.discordWrites(), [
      {
        method: "POST",
        path: "/api/v10/channels/110/messages",
        body: {
          content: "Reviewed report.txt",
          allowed_mentions: { parse: [], replied_user: false },
          message_reference: { message_id: "111", channel_id: "110", fail_if_not_exists: true },
        },
      },
    ]);
  }, 300_000);
});
