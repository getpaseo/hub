import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { summarizeTrigger } from "../../projects/activity-summary.js";
import { readJson } from "../../providers/forgejo/contract-test-read.js";
import {
  deliveryByName,
  loadForgejoContractFixtures,
} from "../../providers/forgejo/fake-server.js";
import {
  encryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch } from "../index.js";
import type { DurableProviderEvent } from "../../db/types.js";
import { createForgejoClaimedHandoff } from "./dispatch.js";
import {
  createForgejoHydrationConsumer,
  createForgejoHydrationTriggerProvider,
  createMemoryForgejoHydrationStore,
  type ForgejoHydrationClient,
} from "./hydration.js";
import { createForgejoReceiptAcceptance } from "./receipt.js";
import { createForgejoTriggerProvider } from "./provider.js";
import { handleForgejoIngress } from "./webhook.js";

const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORGANIZATION_ID = "org-1";
const SECRET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INSTANCE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION = {
  id: CONNECTION_ID,
  slug: "forgejo",
  instanceId: INSTANCE_ID,
};
const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../providers/forgejo/contract-fixtures",
);

describe("Forgejo hydration journey", () => {
  it("turns a signed incomplete label delivery into a matched run, reaction, and native activity link", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "issue-label-updated");
    const timeline = readList(await readJson(join(fixturesRoot, "hydration/timeline-issue.json")));
    const secrets = testSecrets();
    const database = createMemoryDatabase();
    const directory = await seedConnection(database, secrets, fixtures.secret);
    const {
      project,
      revision,
      store: configurationStore,
    } = await createActiveProjectConfiguration(database, labelRouteConfig(), {
      organizationId: ORGANIZATION_ID,
    });
    const hydrationStore = createMemoryForgejoHydrationStore();
    await hydrationStore.seedCursor(
      {
        connectionId: CONNECTION_ID,
        repositoryId: 1,
        subjectKind: "issue",
        subjectId: 3,
        recordKind: "timeline",
      },
      2,
    );
    const enqueued: DurableProviderEvent[] = [];
    const posted: string[] = [];
    const hydration = createForgejoHydrationConsumer({
      store: hydrationStore,
      client: fakeClient(timeline),
      onRecovered: async (event, input) => {
        enqueued.push({
          providerEventReceiptId: input.receiptId,
          organizationId: ORGANIZATION_ID,
          projectId: project.id,
          configurationRevisionId: revision.id,
          source: event.semanticEvent,
          deliveryId: input.delivery.deliveryId,
          receivedAt: input.delivery.receivedAt,
          payload: {
            headers: {
              "x-forgejo-delivery": input.delivery.deliveryId,
              "x-forgejo-event": "hydrated",
              "x-forgejo-event-type": event.semanticEvent,
            },
            raw: JSON.stringify({
              hydration: {
                semanticEvent: event.semanticEvent,
                sourceRecordKind: event.sourceRecordKind,
                sourceRecordId: event.sourceRecordId,
                subjectKind: event.subjectKind,
                subjectId: event.subjectId,
                htmlUrl: event.htmlUrl,
                reactionSubject: event.reactionSubject,
                context: input.signal.context,
              },
            }),
          },
          connectionId: CONNECTION_ID,
          resourceId: "1",
        });
      },
    });
    const accept = createForgejoReceiptAcceptance({
      database,
      onClaimed: createForgejoClaimedHandoff({
        connectionFor: async () => CONNECTION,
        consumers: { hydration },
      }),
    });
    const response = await handleForgejoIngress(
      signedRequest(delivery, fixtures.secret),
      CONNECTION_ID,
      {
        directory,
        secrets,
        accept,
      },
    );
    assert.equal(response.status, 200);
    assert.equal(enqueued.length, 1);
    const recovered = enqueued[0];
    if (recovered === undefined) throw new Error("recovered trigger missing");
    assert.equal(recovered.source, "forgejo.issue_label_added");

    const nativeProvider = createForgejoTriggerProvider({
      configurationStoreForProject: () => configurationStore,
      connectionFor: async () => CONNECTION,
    });
    assert.equal(await nativeProvider.match(recovered), "no_trigger_for_source");

    const hydrationProvider = createForgejoHydrationTriggerProvider({
      configurationStoreForProject: () => configurationStore,
      reactions: {
        create: (input) => {
          posted.push(`${input.subject.kind}:${String(input.subject.id)}:${input.content}`);
          return Promise.resolve();
        },
      },
    });
    const matched = await hydrationProvider.match(recovered);
    if (typeof matched === "string") throw new Error(matched);
    const accepted = matched[0];
    if (accepted === undefined || !isAcceptedTriggerProviderMatch(accepted)) {
      throw new Error("expected accepted hydration match");
    }
    assert.equal(accepted.triggerName, "forgejo-label");
    assert.equal(accepted.triggerContext.reactionSubject?.kind, "issue");
    assert.equal(accepted.triggerContext.reactionSubject?.id, 3);
    await hydrationProvider.onDispatchAccepted?.(accepted.triggerContext, accepted.outputContext);
    assert.deepEqual(posted, ["issue:3:eyes"]);

    const summary = summarizeTrigger(recovered.source, recovered.payload);
    assert.equal(summary.provider, "forgejo");
    assert.equal(
      summary.externalUrl,
      "https://forgejo.example.test/t00org/t00repo/issues/3#issuecomment-3",
    );
    assert.match(summary.headline, /#3/u);
  });
});

function labelRouteConfig() {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "forgejo-label",
        on: "forgejo.issue_label_added",
        max_runtime: "2h",
        filters: { from_users: ["*"] },
        steps: [
          {
            id: "reply",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "default" },
            prompt: [{ text: "Handle the label" }],
          },
        ],
      },
    ],
  };
}

function fakeClient(timeline: readonly unknown[]): ForgejoHydrationClient {
  return {
    listSubjects: () => Promise.resolve([]),
    listTimeline: () => Promise.resolve(timeline),
    listReviews: () => Promise.resolve([]),
    listReviewComments: () => Promise.resolve([]),
  };
}

function readList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function signedRequest(
  delivery: { headers: Record<string, unknown>; raw: string },
  secret: string,
): Request {
  const signature = createHmac("sha256", secret).update(delivery.raw, "utf8").digest("hex");
  return new Request(`https://hub.example.test/webhook/${CONNECTION_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forgejo-delivery": header(delivery, "x-forgejo-delivery"),
      "x-forgejo-event": header(delivery, "x-forgejo-event"),
      "x-forgejo-event-type": header(delivery, "x-forgejo-event-type"),
      "x-forgejo-signature": signature,
    },
    body: delivery.raw,
  });
}

function header(delivery: { headers: Record<string, unknown> }, name: string): string {
  const value = delivery.headers[name];
  if (typeof value !== "string") throw new Error(`missing ${name}`);
  return value;
}

async function seedConnection(
  database: ReturnType<typeof createMemoryDatabase>,
  secrets: SecretEncryptionKeySource,
  plaintext: string,
) {
  const now = new Date("2026-08-30T00:00:00.000Z");
  const envelope = encryptSecret(secrets, {
    plaintext,
    organizationId: ORGANIZATION_ID,
    credentialId: SECRET_ID,
    kind: "webhook_secret",
  });
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
    organizationId: ORGANIZATION_ID,
    instanceId: INSTANCE_ID,
    slug: "forgejo",
    status: "active",
    forgejoUserId: 1,
    forgejoUserLogin: "t00user",
    providerApplicationId: null,
  });
  await directory.upsertRepository({
    id: randomUUID(),
    organizationId: ORGANIZATION_ID,
    connectionId: CONNECTION_ID,
    repositoryId: 1,
    fullName: "t00org/t00repo",
    ownerLogin: "t00org",
    name: "t00repo",
    defaultBranch: "main",
    htmlUrl: "https://forgejo.example.test/t00org/t00repo",
    enrolled: true,
  });
  await directory.insertWebhookSecret({
    id: SECRET_ID,
    organizationId: ORGANIZATION_ID,
    connectionId: CONNECTION_ID,
    kind: "webhook_secret",
    alg: envelope.alg,
    keyId: envelope.keyId,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    aadVersion: envelope.aadVersion,
    status: "active",
  });
  await directory.upsertRepositoryHook({
    id: randomUUID(),
    organizationId: ORGANIZATION_ID,
    connectionId: CONNECTION_ID,
    repositoryId: 1,
    forgejoHookId: 9,
    callbackPath: `/api/integrations/forgejo/webhook/${CONNECTION_ID}`,
    managed: true,
    status: "active",
    lastVerifiedAt: now,
  });
  return directory;
}

function testSecrets(): SecretEncryptionKeySource {
  const key = randomBytes(32);
  const current = { keyId: 1, key };
  return {
    current: () => current,
    byId: (id) => (id === 1 ? current : undefined),
  };
}
