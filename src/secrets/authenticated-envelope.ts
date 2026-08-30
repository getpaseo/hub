import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export const FORGEJO_CREDENTIAL_ALG = "aes-256-gcm" as const;
export const FORGEJO_CREDENTIAL_AAD_VERSION = 1;
export const SECRET_ENCRYPTION_KEY_ENV = "PASEO_HUB_SECRET_ENCRYPTION_KEY";

export type ForgejoCredentialKind = "connection" | "execution" | "webhook_secret";

export interface EncryptionKey {
  keyId: number;
  key: Buffer;
}

export interface SecretEncryptionKeySource {
  current(): EncryptionKey | undefined;
  byId(keyId: number): EncryptionKey | undefined;
}

export interface AuthenticatedEnvelope {
  alg: typeof FORGEJO_CREDENTIAL_ALG;
  keyId: number;
  nonce: Buffer;
  ciphertext: Buffer;
  aadVersion: typeof FORGEJO_CREDENTIAL_AAD_VERSION;
}

export class SecretEnvelopeError extends Error {
  readonly code: "key_unavailable" | "key_unknown" | "tampered" | "aad_mismatch";

  constructor(code: SecretEnvelopeError["code"], message: string) {
    super(message);
    this.name = "SecretEnvelopeError";
    this.code = code;
  }
}

export function additionalAuthenticatedData(input: {
  organizationId: string;
  credentialId: string;
  kind: ForgejoCredentialKind;
}): Buffer {
  return Buffer.from(
    `forgejo-credential|v1|${input.organizationId}|${input.credentialId}|${input.kind}`,
    "utf8",
  );
}

export function envSecretEncryptionKeySource(
  env: NodeJS.Dict<string> = process.env,
  keyId = 1,
): SecretEncryptionKeySource {
  const raw = env[SECRET_ENCRYPTION_KEY_ENV];
  const parsed = parseKey(raw);
  const key = parsed === undefined ? undefined : { keyId, key: parsed };
  return {
    current: () => key,
    byId: (id) => (key !== undefined && id === key.keyId ? key : undefined),
  };
}

export function encryptSecret(
  source: SecretEncryptionKeySource,
  input: {
    plaintext: string;
    organizationId: string;
    credentialId: string;
    kind: ForgejoCredentialKind;
  },
): AuthenticatedEnvelope {
  const current = source.current();
  if (current === undefined) {
    throw new SecretEnvelopeError("key_unavailable", "secret encryption key is unavailable");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv(FORGEJO_CREDENTIAL_ALG, current.key, nonce);
  const aad = additionalAuthenticatedData(input);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(input.plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    alg: FORGEJO_CREDENTIAL_ALG,
    keyId: current.keyId,
    nonce,
    ciphertext,
    aadVersion: FORGEJO_CREDENTIAL_AAD_VERSION,
  };
}

export function decryptSecret(
  source: SecretEncryptionKeySource,
  envelope: AuthenticatedEnvelope,
  input: {
    organizationId: string;
    credentialId: string;
    kind: ForgejoCredentialKind;
  },
): string {
  const key = source.byId(envelope.keyId);
  if (key === undefined) {
    throw new SecretEnvelopeError(
      source.current() === undefined ? "key_unavailable" : "key_unknown",
      "secret encryption key is unavailable",
    );
  }
  if (
    envelope.alg !== FORGEJO_CREDENTIAL_ALG ||
    envelope.aadVersion !== FORGEJO_CREDENTIAL_AAD_VERSION
  ) {
    throw new SecretEnvelopeError("tampered", "unsupported secret envelope");
  }
  if (envelope.ciphertext.length < 16) {
    throw new SecretEnvelopeError("tampered", "secret envelope is truncated");
  }
  const data = envelope.ciphertext.subarray(0, envelope.ciphertext.length - 16);
  const tag = envelope.ciphertext.subarray(envelope.ciphertext.length - 16);
  const decipher = createDecipheriv(FORGEJO_CREDENTIAL_ALG, key.key, envelope.nonce);
  decipher.setAAD(additionalAuthenticatedData(input));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretEnvelopeError("tampered", "secret envelope failed authentication");
  }
}

export function maskSecret(): "••••" {
  return "••••";
}

export function envelopesEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : undefined;
  } catch {
    return undefined;
  }
}
