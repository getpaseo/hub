import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  envSecretEncryptionKeySource,
  maskSecret,
  SECRET_ENCRYPTION_KEY_ENV,
  type SecretEncryptionKeySource,
} from "./authenticated-envelope.js";

function sourceFromKey(key: Buffer, keyId = 1): SecretEncryptionKeySource {
  const current = { keyId, key };
  return {
    current: () => current,
    byId: (id) => (id === keyId ? current : undefined),
  };
}

describe("authenticated Forgejo secret envelope", () => {
  it("round-trips a credential and fails closed without a key", () => {
    const key = randomBytes(32);
    const source = sourceFromKey(key);
    const envelope = encryptSecret(source, {
      plaintext: "forgejo_pat_example",
      organizationId: "org_1",
      credentialId: "cred_1",
      kind: "connection",
    });
    assert.equal(envelope.alg, "aes-256-gcm");
    assert.equal(envelope.keyId, 1);
    assert.equal(envelope.nonce.length, 12);
    assert.equal(
      decryptSecret(source, envelope, {
        organizationId: "org_1",
        credentialId: "cred_1",
        kind: "connection",
      }),
      "forgejo_pat_example",
    );
    assert.throws(
      () =>
        encryptSecret(envSecretEncryptionKeySource({}), {
          plaintext: "forgejo_pat_example",
          organizationId: "org_1",
          credentialId: "cred_1",
          kind: "connection",
        }),
      { code: "key_unavailable" },
    );
  });

  it("rejects tamper, wrong AAD, and unknown key versions", () => {
    const source = sourceFromKey(randomBytes(32));
    const identity = {
      organizationId: "org_1",
      credentialId: "cred_1",
      kind: "connection" as const,
    };
    const envelope = encryptSecret(source, { ...identity, plaintext: "secret" });
    const tampered = {
      ...envelope,
      ciphertext: Buffer.from(envelope.ciphertext),
    };
    tampered.ciphertext[0] = tampered.ciphertext[0] === 0 ? 1 : 0;
    assert.throws(() => decryptSecret(source, tampered, identity), { code: "tampered" });
    assert.throws(() => decryptSecret(source, envelope, { ...identity, kind: "execution" }), {
      code: "tampered",
    });
    const other = sourceFromKey(randomBytes(32), 2);
    assert.throws(() => decryptSecret(other, envelope, identity), { code: "key_unknown" });
    assert.equal(maskSecret(), "••••");
    const json = JSON.stringify({ display: maskSecret(), envelope: undefined });
    assert.equal(json.includes("secret"), false);
  });

  it("reads a 32-byte base64 env key and ignores malformed material", () => {
    const key = randomBytes(32);
    const env = { [SECRET_ENCRYPTION_KEY_ENV]: key.toString("base64") };
    const loaded = envSecretEncryptionKeySource(env);
    const envelope = encryptSecret(loaded, {
      plaintext: "token",
      organizationId: "org",
      credentialId: "id",
      kind: "webhook_secret",
    });
    assert.equal(
      decryptSecret(loaded, envelope, {
        organizationId: "org",
        credentialId: "id",
        kind: "webhook_secret",
      }),
      "token",
    );
    assert.equal(
      envSecretEncryptionKeySource({ [SECRET_ENCRYPTION_KEY_ENV]: "not-base64-32" }).current(),
      undefined,
    );
  });
});
