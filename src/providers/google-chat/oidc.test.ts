import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, it } from "vitest";
import {
  GoogleChatOidcVerificationError,
  createGoogleChatOidcVerifier,
  isAuthorizedGoogleChatServiceAccount,
} from "./oidc.js";

const KEY_A = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY_B = generateKeyPairSync("rsa", { modulusLength: 2048 });
const AUDIENCE = "https://hub.example.com/api/integrations/google-chat/events";

function toPublicJwk(publicKey: KeyObject, kid: string) {
  const exported = publicKey.export({ format: "jwk" });
  return {
    kid,
    kty: "RSA" as const,
    alg: "RS256",
    use: "sig",
    n: exported.n!,
    e: exported.e!,
  };
}

function signIdToken(options: {
  privateKey: KeyObject;
  kid: string;
  nowMs: number;
  audience?: string;
  issuer?: string;
  email?: string;
  emailVerified?: boolean;
}): string {
  const nowSeconds = Math.floor(options.nowMs / 1000);
  return jwt.sign(
    {
      iss: options.issuer ?? "https://accounts.google.com",
      aud: options.audience ?? AUDIENCE,
      email: options.email ?? "chat@system.gserviceaccount.com",
      email_verified: options.emailVerified ?? true,
      sub: "1234567890",
      iat: nowSeconds - 10,
      exp: nowSeconds + 300,
    },
    options.privateKey,
    {
      algorithm: "RS256",
      keyid: options.kid,
    },
  );
}

describe("Google Chat OIDC webhook verification", () => {
  it("recognizes classic Chat and Workspace Add-on sender service accounts", () => {
    assert.equal(isAuthorizedGoogleChatServiceAccount("chat@system.gserviceaccount.com"), true);
    assert.equal(
      isAuthorizedGoogleChatServiceAccount(
        "service-123456789@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      ),
      true,
    );
    assert.equal(isAuthorizedGoogleChatServiceAccount("attacker@example.com"), false);
    assert.equal(
      isAuthorizedGoogleChatServiceAccount("custom-bot@example-project.iam.gserviceaccount.com"),
      false,
    );
  });

  it("verifies signed tokens, honors Cache-Control max-age, and rotates keys on unknown kid", async () => {
    let nowMs = 1_700_000_000_000;
    let fetches = 0;
    let activeKeys = [toPublicJwk(KEY_A.publicKey, "kid-a")];

    const verifier = createGoogleChatOidcVerifier({
      expectedAudience: AUDIENCE,
      now: () => nowMs,
      fetch: async () => {
        fetches += 1;
        return new Response(JSON.stringify({ keys: activeKeys }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=600",
          },
        });
      },
    });

    const classicToken = signIdToken({ privateKey: KEY_A.privateKey, kid: "kid-a", nowMs });
    const claims = await verifier.verifyAuthorizationHeader(`Bearer ${classicToken}`);
    assert.equal(claims.email, "chat@system.gserviceaccount.com");
    assert.equal(claims.issuer, "https://accounts.google.com");
    assert.equal(fetches, 1);

    const addonToken = signIdToken({
      privateKey: KEY_A.privateKey,
      kid: "kid-a",
      nowMs,
      email: "service-987654321@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
    });
    const addonClaims = await verifier.verifyBearerToken(addonToken);
    assert.equal(
      addonClaims.email,
      "service-987654321@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
    );
    assert.equal(fetches, 1);

    // Advance past the 10-second refresh guard and rotate to kid-b.
    nowMs += 15_000;
    activeKeys = [toPublicJwk(KEY_B.publicKey, "kid-b")];
    const rotatedToken = signIdToken({ privateKey: KEY_B.privateKey, kid: "kid-b", nowMs });
    const rotatedClaims = await verifier.verifyBearerToken(rotatedToken);
    assert.equal(rotatedClaims.email, "chat@system.gserviceaccount.com");
    assert.equal(fetches, 2);
  });

  it("rejects wrong audience, unverified email, unauthorized sender, and invalid signature", async () => {
    const nowMs = 1_700_000_000_000;
    const verifier = createGoogleChatOidcVerifier({
      expectedAudience: AUDIENCE,
      now: () => nowMs,
      fetch: async () =>
        Response.json({
          keys: [toPublicJwk(KEY_A.publicKey, "kid-a")],
        }),
    });

    await assert.rejects(
      () => verifier.verifyAuthorizationHeader(null),
      GoogleChatOidcVerificationError,
    );
    await assert.rejects(
      () =>
        verifier.verifyBearerToken(
          signIdToken({
            privateKey: KEY_A.privateKey,
            kid: "kid-a",
            nowMs,
            audience: "https://other.example.com/events",
          }),
        ),
      GoogleChatOidcVerificationError,
    );
    await assert.rejects(
      () =>
        verifier.verifyBearerToken(
          signIdToken({
            privateKey: KEY_A.privateKey,
            kid: "kid-a",
            nowMs,
            emailVerified: false,
          }),
        ),
      GoogleChatOidcVerificationError,
    );
    await assert.rejects(
      () =>
        verifier.verifyBearerToken(
          signIdToken({
            privateKey: KEY_A.privateKey,
            kid: "kid-a",
            nowMs,
            email: "someone@example.com",
          }),
        ),
      GoogleChatOidcVerificationError,
    );
    await assert.rejects(
      () =>
        verifier.verifyBearerToken(
          signIdToken({
            privateKey: KEY_B.privateKey,
            kid: "kid-a",
            nowMs,
          }),
        ),
      GoogleChatOidcVerificationError,
    );
  });
});
