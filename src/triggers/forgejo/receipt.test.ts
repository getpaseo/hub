import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import {
  encryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import {
  deliveryByName,
  loadForgejoContractFixtures,
} from "../../providers/forgejo/fake-server.js";
import { createForgejoReceiptAcceptance, hashForgejoBody } from "./receipt.js";
import { handleForgejoIngress, type ForgejoVerifiedDelivery } from "./webhook.js";

const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORGANIZATION_ID = "org-1";
const SECRET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INSTANCE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("Forgejo durable receipts", () => {
  it("persists a verified delivery before ACK and replays the same body without a second T05 handoff", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "issues-opened");
    const secrets = testSecrets();
    const database = createMemoryDatabase();
    const directory = await seedConnection(database, secrets, fixtures.secret);
    const claimed: string[] = [];
    const accept = createForgejoReceiptAcceptance({
      database,
      onClaimed: async ({ receiptId }) => {
        claimed.push(receiptId);
      },
    });
    const first = await handleForgejoIngress(
      signedRequest(delivery, fixtures.secret),
      CONNECTION_ID,
      { directory, secrets, accept },
    );
    assert.equal(first.status, 200);
    assert.equal(claimed.length, 1);
    const stored = await database.findProviderEventReceiptById(claimed[0]!);
    assert.equal(stored?.provider, "forgejo");
    assert.equal(stored?.connectionId, CONNECTION_ID);
    assert.equal(stored?.deliveryId, header(delivery, "x-forgejo-delivery"));
    assert.equal(stored?.bodySha256, hashForgejoBody(Buffer.from(delivery.raw, "utf8")));
    assert.equal(JSON.stringify(stored?.payload).includes(fixtures.secret), false);

    const replay = await handleForgejoIngress(
      signedRequest(delivery, fixtures.secret),
      CONNECTION_ID,
      { directory, secrets, accept },
    );
    assert.equal(replay.status, 200);
    assert.equal(claimed.length, 1);
  });

  it("returns 409 when the same delivery id arrives with a different body", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const opened = deliveryByName(fixtures, "issues-opened");
    const secrets = testSecrets();
    const database = createMemoryDatabase();
    const directory = await seedConnection(database, secrets, fixtures.secret);
    const claimed: string[] = [];
    const accept = createForgejoReceiptAcceptance({
      database,
      onClaimed: async ({ receiptId }) => {
        claimed.push(receiptId);
      },
    });
    const first = await handleForgejoIngress(
      signedRequest(opened, fixtures.secret),
      CONNECTION_ID,
      { directory, secrets, accept },
    );
    assert.equal(first.status, 200);
    const conflictingRaw = opened.raw.replace("opened", "closed");
    const conflict = await handleForgejoIngress(
      signedRequest({ ...opened, raw: conflictingRaw }, fixtures.secret),
      CONNECTION_ID,
      { directory, secrets, accept },
    );
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "forgejo_delivery_conflict" });
    assert.equal(claimed.length, 1);
    const stored = await database.findProviderEventReceiptById(claimed[0]!);
    assert.equal(stored?.bodySha256, hashForgejoBody(Buffer.from(opened.raw, "utf8")));
  });

  it("does not ACK when the connection is unknown to the receipt store", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "issues-opened");
    const secrets = testSecrets();
    const directory = await seedConnection(createMemoryDatabase(), secrets, fixtures.secret);
    const accept = createForgejoReceiptAcceptance({ database: createMemoryDatabase() });
    const response = await handleForgejoIngress(
      signedRequest(delivery, fixtures.secret),
      CONNECTION_ID,
      { directory, secrets, accept },
    );
    assert.equal(response.status, 503);
  });

  it("hands a claimed envelope to T05 exactly once under concurrent identical deliveries", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "issues-opened");
    const secrets = testSecrets();
    const database = createMemoryDatabase();
    const directory = await seedConnection(database, secrets, fixtures.secret);
    const claimed: ForgejoVerifiedDelivery[] = [];
    const accept = createForgejoReceiptAcceptance({
      database,
      onClaimed: async ({ delivery: envelope }) => {
        claimed.push(envelope);
      },
    });
    const responses = await Promise.all(
      [0, 1, 2].map(() =>
        handleForgejoIngress(signedRequest(delivery, fixtures.secret), CONNECTION_ID, {
          directory,
          secrets,
          accept,
        }),
      ),
    );
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200, 200],
    );
    assert.equal(claimed.length, 1);
  });
});

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
