import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import {
  acceptingAgentValidator,
  catalogAgentValidator,
  disconnectedAgentValidator,
} from "../test-utils/agent-validator.js";
import { OrganizationTriggerStore } from "./store.js";

describe("organization trigger store", () => {
  it("creates and updates one hidden runtime without exposing a project", async () => {
    const database = await enrolledDatabase();
    const store = new OrganizationTriggerStore(database, "org", acceptingAgentValidator());
    const first = await store.save({ yaml: triggerYaml(true), userId: null });
    const second = await store.save({
      triggerId: first.id,
      yaml: triggerYaml(false),
      userId: null,
    });

    assert.equal(second.id, first.id);
    assert.equal(second.runtimeProjectId, first.runtimeProjectId);
    assert.equal(second.enabled, false);
    assert.equal((await database.listProjectsForOrganization("org")).length, 0);
    assert.equal((await store.activeRevision(second)).version, 2);
  });

  it("fails validation before creating storage when the daemon is unknown", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org"] });
    const store = new OrganizationTriggerStore(database, "org", acceptingAgentValidator());

    await assert.rejects(store.save({ yaml: triggerYaml(true), userId: null }), /daemon/u);
    assert.equal((await store.list()).length, 0);
    assert.equal((await database.listProjectsForOrganization("org")).length, 0);
  });

  it.each([
    ["a relative working directory", "cwd: workspace", /absolute path/iu],
    ["an omitted execution mode", "provider: codex, mode: full-access", /mode.*required/iu],
  ])("rejects %s at the authoring boundary", async (_name, authored, expected) => {
    const database = createMemoryDatabase({ organizationIds: ["org"] });
    const store = new OrganizationTriggerStore(database, "org", acceptingAgentValidator());
    const yaml = triggerYaml(true).replace(
      authored === "cwd: workspace" ? "cwd: /workspace" : authored,
      authored === "cwd: workspace" ? authored : "provider: codex",
    );

    await assert.rejects(store.save({ yaml, userId: null }), expected);
  });

  /**
   * The production failures: `Invalid mode 'default' for provider 'opencode'. Available modes:
   * build, plan` was thrown by the daemon at launch, after Hub had accepted the document. The
   * daemon's catalog is the authority, and Hub asks it before anything is stored.
   */
  it("rejects a mode the target daemon does not offer, before creating storage", async () => {
    const database = await enrolledDatabase();
    const store = new OrganizationTriggerStore(
      database,
      "org",
      catalogAgentValidator({ opencode: { modes: ["build", "plan"] } }),
    );

    await assert.rejects(
      store.save({
        yaml: triggerYaml(true).replace(
          "agent: { provider: codex, mode: full-access }",
          "agent: { provider: opencode, mode: default }",
        ),
        userId: null,
      }),
      /run\.agent\.mode: Mode 'default' is not available for provider 'opencode'/u,
    );
    assert.equal((await store.list()).length, 0);
  });

  it("rejects a model the target daemon does not offer", async () => {
    const database = await enrolledDatabase();
    const store = new OrganizationTriggerStore(
      database,
      "org",
      catalogAgentValidator({ codex: { models: ["gpt-5.4"], modes: ["full-access"] } }),
    );

    await assert.rejects(
      store.save({
        yaml: triggerYaml(true).replace(
          "agent: { provider: codex, mode: full-access }",
          "agent: { provider: codex, model: gpt-2, mode: full-access }",
        ),
        userId: null,
      }),
      /run\.agent\.model: Model 'gpt-2' is not available/u,
    );
  });

  /**
   * `Provider 'omp' cannot preapprove exact MCP tools for unattended execution` is what the
   * daemon says when Hub sends its tool policy to a provider that cannot honour one. Hub sends
   * that policy with every run, so the provider is refused at save.
   */
  it("rejects a provider that cannot run unattended, without asking the daemon", async () => {
    const database = await enrolledDatabase();
    const store = new OrganizationTriggerStore(
      database,
      "org",
      catalogAgentValidator({ omp: { modes: ["full-access"] } }),
    );

    await assert.rejects(
      store.save({
        yaml: triggerYaml(true).replace("provider: codex", "provider: omp"),
        userId: null,
      }),
      /run\.agent\.provider: Provider 'omp' cannot run unattended Hub automations; select Claude, Codex, or OpenCode/u,
    );
  });

  it("refuses a new trigger while the target daemon cannot be asked", async () => {
    const database = await enrolledDatabase();
    const store = new OrganizationTriggerStore(database, "org", disconnectedAgentValidator());

    await assert.rejects(
      store.save({ yaml: triggerYaml(true), userId: null }),
      /run\.target\.daemon: "devbox" is not connected, so Hub cannot check this agent against it/u,
    );
  });

  it("still saves a prompt edit while the daemon is offline when the agent is unchanged", async () => {
    const database = await enrolledDatabase();
    const connected = new OrganizationTriggerStore(database, "org", acceptingAgentValidator());
    const trigger = await connected.save({ yaml: triggerYaml(true), userId: null });
    const offline = new OrganizationTriggerStore(database, "org", disconnectedAgentValidator());

    const edited = await offline.save({
      triggerId: trigger.id,
      yaml: triggerYaml(true).replace("prompt: Handle it", "prompt: Handle it carefully"),
      userId: null,
    });
    assert.equal((await offline.activeRevision(edited)).version, 2);

    await assert.rejects(
      offline.save({
        triggerId: trigger.id,
        yaml: triggerYaml(true).replace("mode: full-access", "mode: read-only"),
        userId: null,
      }),
      /"devbox" is not connected/u,
    );
  });

  it("validates every agent choice against the daemon", async () => {
    const database = await enrolledDatabase();
    const store = new OrganizationTriggerStore(
      database,
      "org",
      catalogAgentValidator({
        codex: { modes: ["full-access"] },
        opencode: { modes: ["build"] },
      }),
    );

    await assert.rejects(
      store.save({
        yaml: triggerYaml(true)
          .replace(
            "on:\n",
            "inputs:\n  runtime: { type: string, required: true, choices: [fast, slow] }\non:\n",
          )
          .replace(
            "agent: { provider: codex, mode: full-access }",
            `agent:
    select: \${{ paseo.inputs.runtime }}
    choices:
      fast: { provider: codex, mode: full-access }
      slow: { provider: opencode, mode: default }`,
          ),
        userId: null,
      }),
      /run\.agent\.choices\.slow\.mode: Mode 'default' is not available/u,
    );
  });
});

async function enrolledDatabase(): Promise<Database> {
  const database = createMemoryDatabase({ organizationIds: ["org"] });
  await database.issueEnrollmentToken({
    id: "token",
    verifier: "token-verifier",
    organizationId: "org",
    expiresAt: new Date("2026-08-29T22:00:00.000Z"),
    consumedAt: null,
  });
  await database.enrollDaemon({
    daemonId: "daemon-00000000",
    idempotencyKey: "daemon-key",
    suggestedSlug: "devbox",
    tokenVerifier: "token-verifier",
    serverId: "server",
    daemonPublicKey: "public-key",
    credentialVerifier: "credential-verifier",
    permissions: ["hub.execute"],
    now: new Date("2026-08-29T21:00:00.000Z"),
  });
  return database;
}

function triggerYaml(enabled: boolean): string {
  return `name: manual-task
enabled: ${String(enabled)}
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
  max_runtime: 1h
  idle_timeout: 5m
`;
}
