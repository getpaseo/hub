import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  compiledConfigurationHash,
  parseCompiledHubConfig,
  rawConfigurationHash,
} from "../config/compiler.js";
import { ProjectConfigurationStore } from "./store.js";
import { createMemoryDatabase } from "../db/memory.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import type { DiscordConnectionRecord } from "../db/types.js";

const primary: DiscordConnectionRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  organizationId: "org_1",
  guildId: "100",
  slug: "discord-primary",
  guildName: "Primary guild",
};

const secondary: DiscordConnectionRecord = {
  ...primary,
  id: "00000000-0000-4000-8000-000000000002",
  guildId: "200",
  slug: "discord-secondary",
  guildName: "Secondary guild",
};

describe("ProjectConfigurationStore resource compilation", () => {
  it("accepts guild and scopes an authored resource to an optional connection slug", async () => {
    const database = createMemoryDatabase();
    await enrollTestDaemon(database);
    const connections = [primary, secondary];
    database.organizationConnectionUsage = () =>
      Promise.resolve({ github: [], slack: [], discord: connections });
    database.findDiscordConnectionForOrganization = async (_organizationId, guildId) =>
      connections.find((connection) => connection.guildId === guildId);
    const project = await database.createProject({
      organizationId: "org_1",
      name: "Guild project",
      slug: "guild-project",
      createdByUserId: "user-1",
    });
    const store = new ProjectConfigurationStore(database, project.id);

    const revision = await store.insertManualRevision({
      rawYaml: null,
      rawConfiguration: discordConfiguration({
        guild: "100",
        connection: "discord-primary",
      }),
      userId: "user-1",
    });
    assert.equal(
      revision.contentHash,
      compiledConfigurationHash(parseCompiledHubConfig(revision.normalizedConfiguration)),
    );
    const active = await store.activate(revision.id);

    assert.equal(revision.validationErrors, null);
    assert.equal(active.configuration.triggers[0]?.filters?.guild, "100");
    assert.equal(active.configuration.triggers[0]?.filters?.connectionId, primary.id);
    assert.deepEqual(active.configuration.triggers[0]?.filters?.resourceId, "100");
    assert.equal(Object.isFrozen(active.configuration.triggers[0]?.filters), true);

    const switched = await store.switchToManual("user-1");
    assert.equal(
      switched.revision.contentHash,
      compiledConfigurationHash(parseCompiledHubConfig(switched.revision.normalizedConfiguration)),
    );
  });

  it("resolves a unique guild without requiring a connection slug", async () => {
    const database = createMemoryDatabase();
    await enrollTestDaemon(database);
    database.organizationConnectionUsage = () =>
      Promise.resolve({ github: [], slack: [], discord: [primary, secondary] });
    database.findDiscordConnectionForOrganization = async (_organizationId, guildId) =>
      guildId === primary.guildId ? primary : undefined;
    const project = await database.createProject({
      organizationId: "org_1",
      name: "Unique guild project",
      slug: "unique-guild-project",
      createdByUserId: "user-1",
    });
    const store = new ProjectConfigurationStore(database, project.id);

    const revision = await store.insertManualRevision({
      rawYaml: null,
      rawConfiguration: discordConfiguration({ guild: "100" }),
      userId: "user-1",
    });
    const active = await store.activate(revision.id);

    assert.equal(active.configuration.triggers[0]?.filters?.connectionId, primary.id);
  });

  it("rejects an unknown explicit connection slug", async () => {
    const database = createMemoryDatabase();
    await enrollTestDaemon(database);
    database.organizationConnectionUsage = () =>
      Promise.resolve({ github: [], slack: [], discord: [primary] });
    const project = await database.createProject({
      organizationId: "org_1",
      name: "Unknown connection project",
      slug: "unknown-connection-project",
      createdByUserId: "user-1",
    });
    const store = new ProjectConfigurationStore(database, project.id);
    const revision = await store.insertManualRevision({
      rawYaml: null,
      rawConfiguration: discordConfiguration({ guild: "100", connection: "missing-discord" }),
      userId: "user-1",
    });

    assert.deepEqual(revision.validationErrors, {
      formErrors: ["unresolved organization resources: discord:connection:missing-discord"],
    });
  });

  it("records a missing daemon as an invalid revision instead of dereferencing it", async () => {
    const database = createMemoryDatabase();
    const project = await database.createProject({
      organizationId: "org_1",
      name: "Missing daemon project",
      slug: "missing-daemon-project",
      createdByUserId: "user-1",
    });
    const store = new ProjectConfigurationStore(database, project.id);

    const revision = await store.insertManualRevision({
      rawYaml: null,
      rawConfiguration: {
        environments: [
          {
            name: "runner",
            kind: "daemon",
            daemon: "missing-daemon",
            cwd: "/workspace",
          },
        ],
        triggers: [],
      },
      userId: "user-1",
    });

    assert.deepEqual(revision.validationErrors, {
      formErrors: ["unresolved organization resources: missing-daemon"],
    });
    assert.equal(
      revision.contentHash,
      compiledConfigurationHash(parseCompiledHubConfig(revision.normalizedConfiguration)),
    );
  });

  it("records invalid authored configuration with its raw configuration hash", async () => {
    const database = createMemoryDatabase();
    const project = await database.createProject({
      organizationId: "org_1",
      name: "Invalid configuration project",
      slug: "invalid-configuration-project",
      createdByUserId: "user-1",
    });
    const store = new ProjectConfigurationStore(database, project.id);
    const rawConfiguration = {
      environments: [],
      triggers: [
        {
          name: "legacy",
          on: "manual.run",
          environment: "docker",
          agent: { provider: "test", mode: "default" },
          prompt: [{ text: "Run" }],
          steps: [],
        },
      ],
    };

    const revision = await store.insertManualRevision({
      rawYaml: "triggers:\n  - name: legacy\n",
      rawConfiguration,
      userId: "user-1",
    });

    assert.notEqual(revision.validationErrors, null);
    assert.equal(revision.contentHash, rawConfigurationHash(rawConfiguration));
  });

  it("accepts one durable trigger per project when multiple routes match", async () => {
    const database = createMemoryDatabase();
    await enrollTestDaemon(database);
    database.organizationConnectionUsage = () =>
      Promise.resolve({ github: [], slack: [], discord: [primary] });
    database.findDiscordConnection = () => Promise.resolve(primary);
    database.findDiscordConnectionForOrganization = async (_organizationId, guildId) =>
      guildId === primary.guildId ? primary : undefined;
    const project = await database.createProject({
      organizationId: "org_1",
      name: "Fan-out project",
      slug: "fan-out-project",
      createdByUserId: "user-1",
    });
    const store = new ProjectConfigurationStore(database, project.id);
    const configuration = discordConfiguration({ guild: "100" });
    configuration.triggers.push({
      ...configuration.triggers[0]!,
      name: "discord-mention-secondary",
    });
    const revision = await store.insertManualRevision({
      rawYaml: null,
      rawConfiguration: configuration,
      userId: "user-1",
    });
    await store.activate(revision.id);

    const accepted = await database.acceptDiscordEvent({
      guildId: "100",
      deliveryId: "discord-fan-out",
      source: "discord.mention",
      payload: {},
      receivedAt: new Date(0),
    });

    assert.equal(accepted.status, "accepted");
    if (accepted.status !== "accepted") return;
    assert.equal(accepted.events.length, 1);
  });

  it("restores the target revision's trigger routes during rollback", async () => {
    const database = createMemoryDatabase();
    await enrollTestDaemon(database);
    database.organizationConnectionUsage = () =>
      Promise.resolve({ github: [], slack: [], discord: [primary] });
    database.findDiscordConnection = () => Promise.resolve(primary);
    database.findDiscordConnectionForOrganization = async (_organizationId, guildId) =>
      guildId === primary.guildId ? primary : undefined;
    const project = await database.createProject({
      organizationId: "org_1",
      name: "Rollback routes project",
      slug: "rollback-routes-project",
      createdByUserId: "user-1",
    });
    const store = new ProjectConfigurationStore(database, project.id);
    const first = await store.insertManualRevision({
      rawYaml: null,
      rawConfiguration: discordConfiguration({ guild: "100" }),
      userId: "user-1",
    });
    await store.activate(first.id);
    const secondConfiguration = discordConfiguration({ guild: "100" });
    secondConfiguration.triggers[0]!.name = "second-discord-mention";
    const second = await store.insertManualRevision({
      rawYaml: null,
      rawConfiguration: secondConfiguration,
      userId: "user-1",
    });
    await store.activate(second.id);

    const rolledBack = await store.rollback();
    assert.equal(rolledBack.revision.id, first.id);
    const accepted = await database.acceptDiscordEvent({
      guildId: "100",
      deliveryId: "discord-rollback-routes",
      source: "discord.mention",
      payload: {},
      receivedAt: new Date(0),
    });

    assert.equal(accepted.status, "accepted");
    if (accepted.status !== "accepted") return;
    assert.equal(accepted.events[0]?.projectId, project.id);
    assert.equal(accepted.events[0]?.source, "discord.mention");
  });
});

function discordConfiguration(filters: Record<string, string>) {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/repo" }],
    triggers: [
      {
        name: "discord-mention",
        on: "discord.mention",
        max_runtime: "1h",
        filters: { ...filters, from_users: ["user-1"] },
        steps: [
          {
            id: "run",
            environment: "runner",
            max_runtime: "30m",
            idle_timeout: "5m",
            agent: { provider: "test", mode: "default" },
            prompt: [{ text: "Handle the mention" }],
          },
        ],
      },
    ],
  };
}
