import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { HubHarness } from "../../daemons/test-utils/hub-harness.js";

describe("production manual runs", () => {
  let hub: HubHarness;
  beforeEach(async () => {
    hub = await HubHarness.start();
  }, 120_000);
  afterEach(async () => {
    await hub.stop();
  }, 120_000);

  it("protects configuration installation and manual runs with machine authentication", async () => {
    await hub.connectDaemon();
    const yaml = hub.manualConfigurationYaml();

    assert.equal((await hub.installConfiguration({ yaml, auth: "missing" })).status, 401);
    assert.equal((await hub.installConfiguration({ yaml, auth: "wrong" })).status, 401);
    assert.equal((await hub.runManual({ auth: "missing" })).status, 401);
    assert.equal((await hub.runManual({ auth: "wrong" })).status, 401);
  });

  it("rejects caller-supplied tenant selection for configuration and dispatch", async () => {
    await hub.connectDaemon();
    await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });

    assert.deepEqual(await hub.attemptOperatorOrganizationOverride("org_2"), {
      configurationStatus: 400,
      manualStatus: 400,
    });
    assert.equal(hub.createdAgentCount(), 0);
  });

  it("never promotes invalid YAML or invalid configuration", async () => {
    await hub.connectDaemon();
    const installed = await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });
    const active = await hub.activeConfiguration();
    const invalidYaml = await hub.installConfiguration({ yaml: "environments: [" });
    const invalidSchema = await hub.installConfiguration({
      yaml: "environments: []\ntriggers: []",
    });

    assert.equal(installed.status, 201);
    assert.deepEqual(await hub.activeConfiguration(), active);
    assert.deepEqual(
      { invalidYaml: invalidYaml.status, invalidSchema: invalidSchema.status },
      { invalidYaml: 422, invalidSchema: 422 },
    );
  });

  it("installs and promotes a valid project configuration revision", async () => {
    await hub.connectDaemon();
    const installed = await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });

    assert.equal(installed.status, 201);
    assert.equal((await hub.activeConfiguration())?.id, installed.versionId);
  });

  it("dispatches a manual trigger with interpolated input and durable ownership", async () => {
    const daemonId = await hub.connectDaemon();
    const installed = await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });
    const run = await hub.runManual({
      service: "payments",
      expectedVersionId: installed.versionId,
    });
    const launch = hub.createdAgentLaunch();
    const execution = await hub.execution(run.executionId ?? "");

    assert.equal(run.status, 200);
    assert.equal(launch.prompt, "Deploy payments for alice");
    assert.equal(Reflect.get(Object(launch.env), "MANUAL_ACTOR"), "alice");
    assert.deepEqual(launch.worktree, {
      mode: "branch-off",
      newBranch: "manual-payments",
      base: "main",
    });
    assert.deepEqual(
      { daemonId: run.daemonId, agentId: run.agentId },
      { daemonId, agentId: execution.daemonAgentId },
    );
    assert.deepEqual(
      { daemonId: execution.daemonId, agentId: execution.daemonAgentId },
      { daemonId, agentId: run.agentId },
    );
    assert.equal(execution.launchIntent?.autoArchive, false);
  });

  it("selects the requested manual trigger", async () => {
    await hub.connectDaemon();
    await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });

    const run = await hub.runManual({ trigger: "rollback", service: "payments" });

    assert.equal(run.status, 200);
    assert.equal(hub.createdAgentLaunch().prompt, "Rollback payments for alice");
  });

  it("requires the expected version to still be current", async () => {
    await hub.connectDaemon();
    const first = await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });
    const current = await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });

    const accepted = await hub.runManual({
      deliveryKey: "current-version",
      expectedVersionId: current.versionId,
    });
    const stale = await hub.runManual({
      deliveryKey: "stale-version",
      expectedVersionId: first.versionId,
    });
    const unknown = await hub.runManual({
      deliveryKey: "unknown-version",
      expectedVersionId: "00000000-0000-4000-8000-000000000000",
    });

    assert.deepEqual(
      { accepted: accepted.status, stale, unknown },
      {
        accepted: 200,
        stale: { status: 409, error: "expected_config_version_not_current" },
        unknown: { status: 409, error: "expected_config_version_not_current" },
      },
    );
    assert.equal(hub.createdAgentCount(), 1);
  });

  it("reports unknown projects and triggers without dispatching", async () => {
    await hub.connectDaemon();
    await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });

    const unknownProject = await hub.runManual({
      projectSlug: "unknown",
      deliveryKey: "unknown-project",
    });
    const unknownTrigger = await hub.runManual({
      trigger: "unknown",
      deliveryKey: "unknown-trigger",
    });

    assert.deepEqual(
      { unknownProject, unknownTrigger },
      {
        unknownProject: { status: 404, error: "project_not_found" },
        unknownTrigger: { status: 404, error: "manual_trigger_not_found" },
      },
    );
    assert.equal(hub.createdAgentCount(), 0);
  });

  it("rejects actors outside the manual trigger policy", async () => {
    await hub.connectDaemon();
    await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });

    assert.equal((await hub.runManual({ actor: "mallory" })).status, 403);
    assert.equal(hub.createdAgentCount(), 0);
  });

  it("returns the same execution for duplicate delivery without creating another agent", async () => {
    await hub.connectDaemon();
    await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });
    const first = await hub.runManual({ deliveryKey: "stable-delivery" });
    const duplicate = await hub.runManual({ deliveryKey: "stable-delivery" });

    assert.deepEqual(duplicate, first);
    assert.equal(hub.createdAgentCount(), 1);
  });

  it("shares one dispatch outcome across concurrent duplicate deliveries", async () => {
    await hub.connectDaemon();
    await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });

    const outcomes = await hub.runOverlappingManualDelivery("concurrent-delivery");

    assert.deepEqual(outcomes.second, outcomes.first);
    assert.equal(outcomes.first.status, 200);
    assert.equal(hub.createdAgentRequestCount(), 1);
  });

  it("resolves a duplicate delivery from durable ownership after restart", async () => {
    await hub.connectDaemon();
    await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });
    const first = await hub.runManual({ deliveryKey: "restart-delivery" });
    await hub.restartApp();

    const duplicate = await hub.runManual({ deliveryKey: "restart-delivery" });

    assert.deepEqual(duplicate, first);
    assert.equal(hub.createdAgentCount(), 1);
  });

  it("fails visibly when the daemon is offline without creating an agent", async () => {
    await hub.connectDaemon();
    await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });
    await hub.disconnectDaemon();
    await hub.observeOfflinePresence();

    const run = await hub.runManual({ deliveryKey: "offline-delivery" });
    assert.deepEqual(
      { status: run.status, error: run.error },
      { status: 409, error: "daemon_offline" },
    );
    assert.equal(hub.createdAgentCount(), 0);
  });
});
