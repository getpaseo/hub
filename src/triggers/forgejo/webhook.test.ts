import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import {
  encryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import {
  deliveryByName,
  loadForgejoContractFixtures,
} from "../../providers/forgejo/fake-server.js";
import { createMemoryForgejoDirectory } from "../../providers/forgejo/instances.js";
import {
  handleForgejoIngress,
  MAX_WEBHOOK_BYTES,
  verifyForgejoSignature,
  type ForgejoVerifiedDelivery,
} from "./webhook.js";

const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORGANIZATION_ID = "org-1";
const SECRET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("Forgejo HMAC verifier", () => {
  it("accepts lowercase hex over exact bytes and rejects prefix, uppercase, and mutated bodies", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "issues-opened");
    const body = Buffer.from(delivery.raw, "utf8");
    const valid = createHmac("sha256", fixtures.secret).update(body).digest("hex");
    assert.equal(verifyForgejoSignature(fixtures.secret, body, valid), true);
    assert.equal(verifyForgejoSignature(fixtures.secret, body, `sha256=${valid}`), false);
    assert.equal(verifyForgejoSignature(fixtures.secret, body, valid.toUpperCase()), false);
    assert.equal(verifyForgejoSignature("wrong-secret", body, valid), false);
    assert.equal(
      verifyForgejoSignature(fixtures.secret, Buffer.from(`${delivery.raw} `), valid),
      false,
    );
    assert.match(valid, /^[0-9a-f]{64}$/u);
  });
});

describe("Forgejo webhook ingress", () => {
  it("rejects malformed headers, oversized bodies, unknown connections, and invalid HMAC before accept", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "issues-opened");
    const secrets = testSecrets();
    const directory = await seededDirectory(secrets, fixtures.secret);
    const accepted: ForgejoVerifiedDelivery[] = [];
    const options = {
      directory,
      secrets,
      accept: async (envelope: ForgejoVerifiedDelivery) => {
        accepted.push(envelope);
        return { status: "accepted" as const };
      },
    };

    const missing = await handleForgejoIngress(
      new Request(`https://hub.example.test/webhook/${CONNECTION_ID}`, {
        method: "POST",
        body: delivery.raw,
      }),
      CONNECTION_ID,
      options,
    );
    assert.equal(missing.status, 400);

    const prefixed = await handleForgejoIngress(
      signedRequest(delivery, fixtures.secret, {
        "x-forgejo-signature": `sha256=${header(delivery, "x-forgejo-signature")}`,
      }),
      CONNECTION_ID,
      options,
    );
    assert.equal(prefixed.status, 400);

    const oversized = await handleForgejoIngress(
      new Request(`https://hub.example.test/webhook/${CONNECTION_ID}`, {
        method: "POST",
        headers: forgejoHeaders(delivery),
        body: "x".repeat(MAX_WEBHOOK_BYTES + 1),
      }),
      CONNECTION_ID,
      options,
    );
    assert.equal(oversized.status, 413);

    const unknown = await handleForgejoIngress(
      signedRequest(delivery, fixtures.secret),
      randomUUID(),
      options,
    );
    assert.equal(unknown.status, 401);

    const invalid = await handleForgejoIngress(
      signedRequest(delivery, "wrong-secret"),
      CONNECTION_ID,
      options,
    );
    assert.equal(invalid.status, 401);
    assert.equal(accepted.length, 0);
  });

  it("stops unenrolled and unconfigured repositories before the T04 seam", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "issues-opened");
    const secrets = testSecrets();
    const directory = await seededDirectory(secrets, fixtures.secret, { enrolled: false });
    const accepted: ForgejoVerifiedDelivery[] = [];
    const response = await handleForgejoIngress(
      signedRequest(delivery, fixtures.secret),
      CONNECTION_ID,
      {
        directory,
        secrets,
        accept: async (envelope) => {
          accepted.push(envelope);
          return { status: "accepted" };
        },
      },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "unconfigured" });
    assert.equal(accepted.length, 0);
  });

  it("hands a valid fixture delivery to the accept seam once and 503s when the seam is absent", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "issues-opened");
    const secrets = testSecrets();
    const directory = await seededDirectory(secrets, fixtures.secret);
    const unavailable = await handleForgejoIngress(
      signedRequest(delivery, fixtures.secret),
      CONNECTION_ID,
      { directory, secrets },
    );
    assert.equal(unavailable.status, 503);

    const accepted: ForgejoVerifiedDelivery[] = [];
    const ok = await handleForgejoIngress(signedRequest(delivery, fixtures.secret), CONNECTION_ID, {
      directory,
      secrets,
      accept: async (envelope) => {
        accepted.push(envelope);
        return { status: "accepted" };
      },
    });
    assert.equal(ok.status, 200);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.connectionId, CONNECTION_ID);
    assert.equal(accepted[0]?.organizationId, ORGANIZATION_ID);
    assert.equal(accepted[0]?.repositoryId, 1);
    assert.equal(accepted[0]?.event, "issues");
    assert.equal(accepted[0]?.rawBody.byteLength, Buffer.byteLength(delivery.raw));
    const hook = await directory.findRepositoryHook(CONNECTION_ID, 1);
    assert.equal(hook?.status, "active");
  });
});

function signedRequest(
  delivery: Awaited<ReturnType<typeof loadForgejoContractFixtures>>["deliveries"][number],
  secret: string,
  overrides: Record<string, string> = {},
): Request {
  const signature = createHmac("sha256", secret).update(delivery.raw, "utf8").digest("hex");
  return new Request(`https://hub.example.test/webhook/${CONNECTION_ID}`, {
    method: "POST",
    headers: {
      ...forgejoHeaders(delivery),
      "x-forgejo-signature": signature,
      ...overrides,
    },
    body: delivery.raw,
  });
}

function forgejoHeaders(
  delivery: Awaited<ReturnType<typeof loadForgejoContractFixtures>>["deliveries"][number],
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-forgejo-delivery": header(delivery, "x-forgejo-delivery"),
    "x-forgejo-event": header(delivery, "x-forgejo-event"),
    "x-forgejo-event-type": header(delivery, "x-forgejo-event-type"),
    "x-forgejo-signature": header(delivery, "x-forgejo-signature"),
  };
}

function header(
  delivery: Awaited<ReturnType<typeof loadForgejoContractFixtures>>["deliveries"][number],
  name: string,
): string {
  const value = delivery.headers[name];
  if (typeof value !== "string") throw new Error(`missing ${name}`);
  return value;
}

async function seededDirectory(
  secrets: SecretEncryptionKeySource,
  plaintext: string,
  options: { enrolled?: boolean } = {},
) {
  const now = new Date("2026-08-30T00:00:00.000Z");
  const envelope = encryptSecret(secrets, {
    plaintext,
    organizationId: ORGANIZATION_ID,
    credentialId: SECRET_ID,
    kind: "webhook_secret",
  });
  return createMemoryForgejoDirectory({
    instances: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
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
      },
    ],
    connections: [
      {
        id: CONNECTION_ID,
        organizationId: ORGANIZATION_ID,
        instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        slug: "forgejo",
        status: "active",
        forgejoUserId: 1,
        forgejoUserLogin: "t00user",
        providerApplicationId: null,
      },
    ],
    repositories: [
      {
        id: randomUUID(),
        organizationId: ORGANIZATION_ID,
        connectionId: CONNECTION_ID,
        repositoryId: 1,
        fullName: "t00org/t00repo",
        ownerLogin: "t00org",
        name: "t00repo",
        defaultBranch: "main",
        htmlUrl: "https://forgejo.example.test/t00org/t00repo",
        enrolled: options.enrolled ?? true,
      },
    ],
    webhookSecrets: [
      {
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
      },
    ],
    hooks: [
      {
        id: randomUUID(),
        organizationId: ORGANIZATION_ID,
        connectionId: CONNECTION_ID,
        repositoryId: 1,
        forgejoHookId: 9,
        callbackPath: `/api/integrations/forgejo/webhook/${CONNECTION_ID}`,
        managed: true,
        status: "pending_verification",
        lastVerifiedAt: null,
      },
    ],
  });
}

function testSecrets(): SecretEncryptionKeySource {
  const key = randomBytes(32);
  const current = { keyId: 1, key };
  return {
    current: () => current,
    byId: (id) => (id === 1 ? current : undefined),
  };
}
