import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { HubE2E } from "./harness/index.js";

const describeHubE2E = process.env["RUN_HUB_E2E"] === "1" ? describe : describe.skip;

describeHubE2E("Paseo Hub cross-repository contract", () => {
  let hub: HubE2E;

  beforeEach(async () => {
    hub = await HubE2E.start();
  }, 120_000);

  afterEach(async () => {
    const shutdown = await hub?.stop();
    assert.ok((shutdown?.durationMs ?? 0) < 10_000);
    assert.deepEqual(shutdown?.leakedProcesses ?? [], []);
  }, 120_000);

  it("connects the source-built daemon through device authorization", async () => {
    const enrollment = await hub.connectWithDeviceAuthorization("Build Studio");
    await hub.daemonIsConnected();

    assert.equal((await hub.status()).state, "connected");
    assert.match(
      enrollment.daemonId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    await hub.disconnect();
  }, 120_000);

  it("connects a real daemon and completes an isolated manual run without relay authority", async () => {
    const enrollment = await hub.issueEnrollment();
    await hub.connect(enrollment);
    await hub.daemonIsConnected();
    const connected = await hub.status();
    const unrelatedAgent = await hub.createUnrelatedLocalAgent();
    await hub.installProductionConfiguration();

    const run = await hub.runManual("canonical-delivery", "payments");
    const completed = await hub.completedRun(run.executionId);
    const capabilityRun = await hub.runCapabilityTrigger("capability-delivery");
    const capability = await hub.completedCapabilityRun(capabilityRun.executionId);
    const denial = await hub.requestForbiddenOperation();
    const steerDenial = await hub.requestForbiddenSteer(unrelatedAgent);

    assert.equal(connected.state, "connected");
    assert.deepEqual(completed, {
      prompt: "Deploy requested for phase-five-operator",
      output: "phase-five:requested",
      status: "succeeded",
      daemonId: enrollment.daemonId,
      agentId: run.agentId,
    });
    assert.deepEqual(capability, {
      reply: "phase-five:mcp-capability",
      outputContext: {
        provider: "discord",
        guildId: "guild-original",
        channelId: "channel-original",
        threadId: "thread-original",
        messageId: "message-original",
      },
      replySucceeded: true,
      duplicateRejected: true,
      secretCompletionEnvPresent: false,
    });
    assert.equal(await hub.isUnrelatedAgentVisible(unrelatedAgent), false);
    assert.deepEqual(denial, {
      type: "rpc_error",
      requestType: "daemon.get_status.request",
      code: "access_denied",
    });
    assert.deepEqual(steerDenial, {
      type: "rpc_error",
      requestType: "send_agent_message_request",
      code: "access_denied",
    });
    assert.deepEqual(hub.relayEvidence(), {
      enabled: false,
      configuredOptions: [],
    });
    assert.equal(hub.daemonAttemptedRelayConnection(), false);

    await hub.disconnect();
    assert.equal((await hub.status()).state, "not_connected");
  }, 120_000);

  it("replays a lost create response across reconnection without duplicating the daemon agent", async () => {
    const enrollment = await hub.issueEnrollment();
    await hub.connect(enrollment);
    await hub.daemonIsConnected();
    await hub.installProductionConfiguration();
    const run = await hub.beginAmbiguousManualRun();

    assert.deepEqual(run.beforeRestart, {
      triggers: 1,
      executions: 1,
      status: "running",
      daemonId: enrollment.daemonId,
      agentId: null,
    });

    await hub.recoverAmbiguousManualRun(run.executionId);
    const recovery = await hub.replayEvidence(run.executionId);
    assert.equal(recovery.executionAgentId, recovery.ownerMatchingAgentId);
    assert.deepEqual(recovery, {
      deliveryTriggers: 1,
      executions: 1,
      persistedDaemonAgents: 1,
      ownerMatchingAgentId: recovery.executionAgentId,
      ownerDaemonId: enrollment.daemonId,
      ownerMatchesAssociation: true,
      executionAgentId: recovery.executionAgentId,
      persistedAssociations: 1,
      createAttempts: 2,
      recoveredAgentId: recovery.executionAgentId,
      recoveredCurrentState: true,
    });

    await hub.allowRecoveredCompletion();
    const recovered = await hub.completedRun(run.executionId);

    assert.deepEqual(recovered, {
      prompt: "Deploy requested for phase-five-operator",
      output: "phase-five:requested",
      status: "succeeded",
      daemonId: enrollment.daemonId,
      agentId: recovery.ownerMatchingAgentId,
    });
  }, 120_000);

  it("fails the same owned running agent when a real daemon restart interrupts it", async () => {
    const enrollment = await hub.issueEnrollment();
    await hub.connect(enrollment);
    await hub.daemonIsConnected();
    await hub.installProductionConfiguration();
    const run = await hub.beginDaemonRestartRun();

    const recovery = await hub.restartDaemonAndRecover(run.executionId);
    assert.deepEqual(recovery, {
      persistedDaemonAgents: 1,
      executionAgentId: run.agentId,
      ownerAgentId: run.agentId,
      ownerDaemonId: enrollment.daemonId,
      associationDaemonId: enrollment.daemonId,
      createAttempts: 2,
      promptAttempts: 1,
      recoveryCreateAttempts: 1,
      statusImmediatelyBeforeRestart: "running",
      recoveredStatusAfterRestart: "closed",
      executionStatus: "failed",
      executionResult: { status: "failed", reason: "agent_interrupted" },
    });
  }, 120_000);
});
