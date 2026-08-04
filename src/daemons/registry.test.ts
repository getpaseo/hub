import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { DaemonCreateResponseLostError } from "./protocol.js";
import { DaemonRegistryHarness } from "./test-utils/daemon-registry-harness.js";

describe("daemon socket generations", () => {
  let daemon: DaemonRegistryHarness;

  beforeEach(async () => {
    daemon = await DaemonRegistryHarness.start();
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it("rejects superseded requests before close and keeps the replacement usable", async () => {
    const oldCreate = await daemon.pendingCreate("old-create");

    const replacement = await daemon.replaceConnection();

    assert.equal(replacement.supersededClosed, false);
    await assert.rejects(oldCreate.promise, {
      name: DaemonCreateResponseLostError.name,
      message: "daemon create response was lost",
    });
    assert.deepEqual(await daemon.completeCreate("new-create", "agent-new"), {
      id: "agent-new",
    });
  });

  it("waits for offline presence before shutdown completes", async () => {
    daemon.holdOfflinePresence();

    daemon.beginStop();
    await daemon.offlinePresenceBegins();

    assert.equal(await daemon.shutdownCompleted(), false);
    daemon.persistOfflinePresence();
    await daemon.shutdownCompletes();
  });

  it("forwards agent status updates to the execution subscriber", async () => {
    const event = await daemon.reportAgentStatus("execution-1", "idle");

    assert.equal(event.type, "agent_update");
    assert.equal(event.executionId, "execution-1");
    if (event.type === "agent_update") assert.equal(event.agent.status, "idle");
  });

  it("pairs execution-control acknowledgements by request, execution, and action", async () => {
    const pending = await daemon.pendingControl("execution-1", "archive");

    daemon.respondControl(pending, { executionId: "execution-stale" });
    assert.equal(await daemon.requestSettled(pending.promise), false);
    daemon.respondControl(pending, { action: "interrupt" });
    assert.equal(await daemon.requestSettled(pending.promise), false);
    daemon.respondControl(pending);

    await pending.promise;
  });

  it("rejects execution-control acknowledgements from a superseded generation", async () => {
    const pending = await daemon.pendingControl("execution-1", "interrupt");

    await daemon.replaceConnection();

    await assert.rejects(pending.promise, /daemon disconnected/u);
  });
});
