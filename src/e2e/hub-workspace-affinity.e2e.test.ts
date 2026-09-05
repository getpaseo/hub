import assert from "node:assert/strict";
import { afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import { HubE2E } from "./harness/index.js";
import { prebuildPaseoArtifacts, resolvePaseoWorktree } from "./harness/source-paseo.js";

const describeAffinityE2E = process.env["RUN_HUB_AFFINITY_E2E"] === "1" ? describe : describe.skip;

describeAffinityE2E("workspace affinity across daemon versions", () => {
  let hub: HubE2E;
  let affinitySupported: boolean;

  beforeAll(async () => {
    const expectation = process.env["PASEO_E2E_AFFINITY_SUPPORTED"];
    assert.ok(expectation === "true" || expectation === "false", "declare daemon capability");
    affinitySupported = expectation === "true";
    await prebuildPaseoArtifacts(resolvePaseoWorktree());
  }, 600_000);

  beforeEach(async () => {
    hub = await HubE2E.start({ completeInTurn: true });
  }, 120_000);

  afterEach(async () => {
    const shutdown = await hub?.stop();
    assert.ok((shutdown?.durationMs ?? 0) < 10_000);
    assert.deepEqual(shutdown?.leakedProcesses ?? [], []);
  }, 120_000);

  it("preserves legacy behavior or reuses and restores the workspace when supported", async () => {
    await hub.connect();
    await hub.daemonIsConnected();
    await hub.installProductionConfiguration("conversation:one");

    const first = await hub.runManual("affinity-first", "payments");
    const firstWorkspace = await hub.completedExecutionWorkspace(first.executionId);
    await hub.expectWorkspaceActive(firstWorkspace, affinitySupported);

    const second = await hub.runManual("affinity-second", "payments");
    const secondWorkspace = await hub.completedExecutionWorkspace(second.executionId);
    assert.notEqual(second.agentId, first.agentId);
    assert.equal(secondWorkspace === firstWorkspace, affinitySupported);
    await hub.expectWorkspaceActive(secondWorkspace, affinitySupported);

    if (affinitySupported) await hub.archiveWorkspace(secondWorkspace);
    const restored = await hub.runManual("affinity-restored", "payments");
    const restoredWorkspace = await hub.completedExecutionWorkspace(restored.executionId);
    assert.notEqual(restored.agentId, second.agentId);
    assert.equal(restoredWorkspace === secondWorkspace, affinitySupported);
    await hub.expectWorkspaceActive(restoredWorkspace, affinitySupported);

    await hub.installProductionConfiguration("conversation:two");
    const unrelated = await hub.runManual("affinity-unrelated", "payments");
    const unrelatedWorkspace = await hub.completedExecutionWorkspace(unrelated.executionId);
    assert.notEqual(unrelatedWorkspace, restoredWorkspace);
    await hub.expectWorkspaceActive(unrelatedWorkspace, affinitySupported);
  }, 180_000);
});
