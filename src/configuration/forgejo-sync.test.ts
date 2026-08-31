import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseCompiledHubConfig } from "../config/compiler.js";
import {
  hashPromptPartialContent,
  type PromptPartialReadResult,
} from "../config/prompt-partials.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import {
  createActiveProjectConfiguration,
  enrollTestDaemon,
  TEST_DAEMON_SLUG,
} from "../test-utils/project-configuration.js";
import {
  createForgejoConfigSyncConsumer,
  synchronizeForgejoDefaultBranch,
  synchronizeForgejoProjectConfiguration,
  type ForgejoConfigurationProvider,
} from "./forgejo-sync.js";

const INITIAL = {
  environments: [{ name: "runner", kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/repo" }],
  triggers: [],
};

const CONNECTION_ID = "10000000-0000-4000-8000-0000000000f1";
const INSTANCE_ID = "10000000-0000-4000-8000-0000000000f2";

function bundle(partial = "Safety instructions") {
  return {
    ".paseo/hub.yml": [
      "environments:",
      "  runner:",
      "    kind: daemon",
      `    daemon: ${TEST_DAEMON_SLUG}`,
      "    cwd: /repo",
      "agents: {}",
    ].join("\n"),
    ".paseo/workflows/request.yml": [
      "name: request",
      "on: manual.run",
      "max_runtime: 1h",
      "steps:",
      "  - id: work",
      "    environment: runner",
      "    max_runtime: 10m",
      "    idle_timeout: 1m",
      "    agent: { provider: codex }",
      "    prompt:",
      "      - include: partials/safety.md",
      "      - text: 'Request: ${{ paseo.prompt }}'",
    ].join("\n"),
    ".paseo/workflows/partials/safety.md": partial,
  };
}

describe("exact-commit Forgejo configuration bundle sync", () => {
  it("discovers, compiles, and stores the complete bundle at one commit", async () => {
    const database = createMemoryDatabase();
    const { project } = await createActiveProjectConfiguration(database, INITIAL);
    await enrollTestDaemon(database);
    const client = new ForgejoBundleFake({ sha: bundle() });

    const result = await sync(database, client, project.id, "sha");
    assert.equal(result.outcome, "activated");
    if (result.outcome !== "activated") return;
    const compiled = parseCompiledHubConfig(result.revision.normalizedConfiguration);
    assert.equal(compiled.triggers[0]?.sourceFile, ".paseo/workflows/request.yml");
    assert.deepEqual(compiled.triggers[0]?.steps[0]?.prompt[0], {
      kind: "partial",
      path: ".paseo/workflows/partials/safety.md",
      content: "Safety instructions",
      contentHash: hashPromptPartialContent("Safety instructions"),
    });
    assert.deepEqual(
      client.lists.map(({ commitSha, prefix }) => ({ commitSha, prefix })),
      [{ commitSha: "sha", prefix: ".paseo" }],
    );
    assert.deepEqual(
      client.reads.map(({ path }) => path),
      Object.keys(bundle()).sort(),
    );
    assert.match(JSON.stringify(result.revision.sourceEvidence), /"kind":"forgejo"/u);
  });

  it("preserves the active revision when a later bundle is invalid", async () => {
    const database = createMemoryDatabase();
    const { project, revision: initial } = await createActiveProjectConfiguration(
      database,
      INITIAL,
    );
    await enrollTestDaemon(database);
    const invalid = {
      ...bundle(),
      ".paseo/hub.yml": `${bundle()[".paseo/hub.yml"]}\ntriggers: []`,
    };
    const client = new ForgejoBundleFake({ valid: bundle(), invalid });

    const valid = await sync(database, client, project.id, "valid");
    assert.equal(valid.outcome, "activated");
    const active = await database.findActiveProjectConfiguration(project.id);
    assert.notEqual(active?.id, initial.id);
    const rejected = await sync(database, client, project.id, "invalid");
    assert.equal(rejected.outcome, "invalid");
    assert.equal((await database.findActiveProjectConfiguration(project.id))?.id, active?.id);
    assert.match(
      JSON.stringify(rejected.outcome === "invalid" ? rejected.revision.validationErrors : null),
      /monolithic triggers/iu,
    );
  });

  it("does not create a second active revision for the same source commit", async () => {
    const database = createMemoryDatabase();
    const { project } = await createActiveProjectConfiguration(database, INITIAL);
    await enrollTestDaemon(database);
    const client = new ForgejoBundleFake({ sha: bundle() });
    const first = await sync(database, client, project.id, "sha");
    const second = await sync(database, client, project.id, "sha");
    assert.equal(first.outcome, "activated");
    assert.equal(second.outcome, "activated");
    if (first.outcome !== "activated" || second.outcome !== "activated") return;
    assert.equal(first.revision.id, second.revision.id);
    const concurrent = await Promise.all([
      sync(database, client, project.id, "sha"),
      sync(database, client, project.id, "sha"),
    ]);
    assert.equal(concurrent[0]?.outcome, "activated");
    assert.equal(concurrent[1]?.outcome, "activated");
    if (concurrent[0]?.outcome !== "activated" || concurrent[1]?.outcome !== "activated") return;
    assert.equal(concurrent[0].revision.id, first.revision.id);
    assert.equal(concurrent[1].revision.id, first.revision.id);
  });

  it("records listing failures and superseded push commits without moving the pointer", async () => {
    const database = createMemoryDatabase();
    const { project, revision } = await createActiveProjectConfiguration(database, INITIAL);
    await seedForgejoSource(database, project.id, project.organizationId);
    const failing = new ForgejoBundleFake({}, {}, new Error("Forgejo unavailable"));
    assert.deepEqual(await sync(database, failing, project.id, "missing"), {
      outcome: "fetch_failed",
    });
    const client = new ForgejoBundleFake({ head: bundle() });
    client.head = "head";
    assert.deepEqual(
      await synchronizeForgejoDefaultBranch({
        database,
        client,
        projectId: project.id,
        expectedCommitSha: "old",
        webhookDeliveryId: "delivery-old",
      }),
      { outcome: "superseded" },
    );
    assert.equal((await database.findActiveProjectConfiguration(project.id))?.id, revision.id);
  });

  it("consumes T05 default-branch pushes independently of workflow runs", async () => {
    const database = createMemoryDatabase();
    const { project } = await createActiveProjectConfiguration(database, INITIAL);
    await enrollTestDaemon(database);
    await seedForgejoSource(database, project.id, project.organizationId);
    const client = new ForgejoBundleFake({ head: bundle() });
    client.head = "head";
    const consumer = createForgejoConfigSyncConsumer({ database, client });
    await consumer.consume({
      receiptId: "receipt-1",
      delivery: {
        connectionId: CONNECTION_ID,
        organizationId: project.organizationId,
        repositoryId: 1,
        deliveryId: "delivery-1",
        event: "push",
        eventType: "push",
        signatureHash: "sig",
        rawBody: new Uint8Array(),
        receivedAt: new Date(),
      },
      event: {
        identity: { eventId: "delivery-1" },
        receiptSource: "forgejo.push",
        rawFamily: "forgejo.push",
        semanticEvent: undefined,
        text: "push",
        labels: [],
        defaultBranchPush: true,
        context: {
          deliveryId: "delivery-1",
          instanceId: INSTANCE_ID,
          connectionId: CONNECTION_ID,
          connectionSlug: "forgejo",
          repository: {
            id: 1,
            full_name: "t00org/t00repo",
            owner: "t00org",
            name: "t00repo",
            default_branch: "main",
            html_url: "https://forgejo.example.test/t00org/t00repo",
          },
          actor: { id: 2, login: "t00bot" },
          subject: { kind: "commit", id: "head", number: null, html_url: null },
          event: "forgejo.push",
          action: null,
          ref: "refs/heads/main",
          htmlUrl: null,
        },
      },
    });
    const active = await database.findActiveProjectConfiguration(project.id);
    assert.equal(active?.sourceKind, "forgejo");
    assert.match(JSON.stringify(active?.sourceEvidence), /"commitSha":"head"/u);
  });

  it.skipIf(process.env["FORGEJO_REAL_SERVICE_SMOKE"] === "1")(
    "keeps live Forgejo 16.0.3 configuration smoke gated until isolated HTTPS is available",
    () => {
      assert.equal(process.env["FORGEJO_REAL_SERVICE_SMOKE"], undefined);
    },
  );
});

class ForgejoBundleFake implements ForgejoConfigurationProvider {
  readonly lists: Array<{ commitSha: string; prefix: string }> = [];
  readonly reads: Array<{ commitSha: string; path: string }> = [];
  head = "";
  constructor(
    private readonly commits: Readonly<Record<string, Readonly<Record<string, string>>>>,
    private readonly kinds: Readonly<
      Record<string, Readonly<Record<string, PromptPartialReadResult["kind"]>>>
    > = {},
    private readonly listError?: Error,
  ) {}
  listConnectionRepositories() {
    return Promise.resolve([]);
  }
  readDefaultBranchHead() {
    return Promise.resolve(this.head);
  }
  listFilesAtCommit(input: { commitSha: string; prefix: string }) {
    this.lists.push(input);
    if (this.listError !== undefined) return Promise.reject(this.listError);
    const commit = this.commits[input.commitSha] ?? {};
    return Promise.resolve(
      Object.keys(commit).map((path) => ({
        path,
        kind: this.kinds[input.commitSha]?.[path] ?? ("file" as const),
      })),
    );
  }
  readFileAtCommit(input: { commitSha: string; path: string }) {
    this.reads.push(input);
    const content = this.commits[input.commitSha]?.[input.path];
    return Promise.resolve(content === undefined ? undefined : { kind: "file" as const, content });
  }
}

function sync(
  database: ReturnType<typeof createMemoryDatabase>,
  client: ForgejoConfigurationProvider,
  projectId: string,
  commitSha: string,
) {
  return synchronizeForgejoProjectConfiguration({
    database,
    client,
    projectId,
    forgejoConnectionId: CONNECTION_ID,
    forgejoRepositoryId: 1,
    forgejoRepositoryFullName: "t00org/t00repo",
    forgejoDefaultBranch: "main",
    commitSha,
    webhookDeliveryId: `delivery-${commitSha}`,
  });
}

async function seedForgejoSource(database: Database, projectId: string, organizationId: string) {
  const now = new Date();
  const directory = database.forgejoDirectory();
  await directory.insertInstance({
    id: INSTANCE_ID,
    canonicalOrigin: "https://forgejo.example.test",
    allowPrivateNetwork: false,
    externalIdentity: { kind: "forgejo", version: "16.0.3" },
    reportedVersion: "16.0.3",
    status: "active",
    approvedByUserId: "operator-1",
    approvedAt: now,
    lastHealthAt: now,
    lastHealthError: null,
    createdAt: now,
    updatedAt: now,
  });
  await directory.insertConnection({
    id: CONNECTION_ID,
    organizationId,
    instanceId: INSTANCE_ID,
    slug: "forgejo",
    status: "active",
    forgejoUserId: 1,
    forgejoUserLogin: "t00user",
    providerApplicationId: null,
  });
  await directory.upsertRepository({
    id: "10000000-0000-4000-8000-0000000000f3",
    organizationId,
    connectionId: CONNECTION_ID,
    repositoryId: 1,
    fullName: "t00org/t00repo",
    ownerLogin: "t00org",
    name: "t00repo",
    defaultBranch: "main",
    htmlUrl: "https://forgejo.example.test/t00org/t00repo",
    enrolled: true,
  });
  await database.setProjectForgejoConfigurationSource({
    projectId,
    forgejoConnectionId: CONNECTION_ID,
    forgejoRepositoryId: 1,
    forgejoRepositoryFullName: "t00org/t00repo",
    forgejoDefaultBranch: "main",
    automaticDeploymentEnabled: true,
    userId: "test-user",
  });
}
