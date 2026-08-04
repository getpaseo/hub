import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
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

  it("lets a real Codex agent finalize a production manual run through MCP", async () => {
    const enrollment = await hub.issueEnrollment();
    await hub.connect(enrollment);
    await hub.daemonIsConnected();
    await hub.installRealAgentConfiguration();

    const run = await hub.runRealAgentManual("real-agent-finalize");
    const evidence = await hub.realAgentCompletionEvidence(run);

    assert.equal(evidence.status, "succeeded");
    assert.equal(evidence.completedByAgent, true);
    assert.equal(evidence.completedToolCall, true);
    assert.equal(evidence.completionHelperLaunched, false);
  }, 300_000);
});
