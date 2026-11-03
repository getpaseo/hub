import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, it } from "vitest";
import {
  CHAT_BOT_SCOPE,
  GOOGLE_OAUTH_TOKEN_URL,
  GoogleAccessTokenError,
  GoogleServiceAccountValidationError,
  PUBSUB_SCOPE,
  createGoogleAccessTokenSource,
  parseGoogleServiceAccountJson,
} from "./auth.js";

const TEST_RSA_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PRIVATE_KEY_PEM = TEST_RSA_KEYS.privateKey
  .export({
    type: "pkcs8",
    format: "pem",
  })
  .toString();
const TEST_PUBLIC_KEY_PEM = TEST_RSA_KEYS.publicKey
  .export({
    type: "spki",
    format: "pem",
  })
  .toString();

function makeServiceAccountJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "example-project",
    private_key_id: "key-123",
    private_key: TEST_PRIVATE_KEY_PEM,
    client_email: "paseo-bot@example-project.iam.gserviceaccount.com",
    token_uri: GOOGLE_OAUTH_TOKEN_URL,
    ...overrides,
  });
}

describe("Google Chat service account authentication", () => {
  it("parses valid service account JSON and normalizes escaped newlines in private_key", () => {
    const escapedKey = TEST_PRIVATE_KEY_PEM.replaceAll("\n", "\\n");
    const credentials = parseGoogleServiceAccountJson(
      makeServiceAccountJson({ private_key: escapedKey }),
    );

    assert.equal(credentials.projectId, "example-project");
    assert.equal(credentials.privateKeyId, "key-123");
    assert.equal(credentials.clientEmail, "paseo-bot@example-project.iam.gserviceaccount.com");
    assert.equal(credentials.tokenUri, GOOGLE_OAUTH_TOKEN_URL);
    assert.equal(credentials.privateKey.includes("\n"), true);
    assert.equal(credentials.privateKey.includes("\\n"), false);
  });

  it("rejects malformed JSON and invalid PEM keys", () => {
    assert.throws(
      () => parseGoogleServiceAccountJson("{not-json"),
      GoogleServiceAccountValidationError,
    );
    assert.throws(
      () => parseGoogleServiceAccountJson(JSON.stringify({ type: "authorized_user" })),
      GoogleServiceAccountValidationError,
    );
    assert.throws(
      () => parseGoogleServiceAccountJson(makeServiceAccountJson({ private_key: "not-a-pem-key" })),
      GoogleServiceAccountValidationError,
    );
  });

  it("signs an RS256 JWT assertion, caches the access token, and deduplicates concurrent refreshes", async () => {
    const credentials = parseGoogleServiceAccountJson(makeServiceAccountJson());
    let nowMs = 1_700_000_000_000;
    const assertions: string[] = [];

    const source = createGoogleAccessTokenSource({
      credentials,
      scopes: [CHAT_BOT_SCOPE, PUBSUB_SCOPE],
      now: () => nowMs,
      fetch: async (input, init) => {
        assert.equal(input, GOOGLE_OAUTH_TOKEN_URL);
        assert.equal(init?.method, "POST");
        const bodyText = typeof init?.body === "string" ? init.body : "";
        const params = new URLSearchParams(bodyText);
        assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
        const assertion = params.get("assertion");
        assert(assertion !== null);
        assertions.push(assertion);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({
          access_token: `test-oauth-token-${String(assertions.length)}`,
          expires_in: 3600,
          token_type: "Bearer",
        });
      },
    });

    const [first, second] = await Promise.all([source.getAccessToken(), source.getAccessToken()]);
    assert.equal(first, "test-oauth-token-1");
    assert.equal(second, "test-oauth-token-1");
    assert.equal(assertions.length, 1);

    const verified = jwt.verify(assertions[0]!, TEST_PUBLIC_KEY_PEM, {
      algorithms: ["RS256"],
      audience: GOOGLE_OAUTH_TOKEN_URL,
      clockTimestamp: Math.floor(nowMs / 1000),
    });
    assert(typeof verified === "object" && verified !== null);
    assert.equal(verified["iss"], credentials.clientEmail);
    assert.equal(verified["sub"], credentials.clientEmail);
    assert.equal(verified["scope"], `${CHAT_BOT_SCOPE} ${PUBSUB_SCOPE}`);

    nowMs += 30 * 60 * 1000;
    assert.equal(await source.getAccessToken(), "test-oauth-token-1");
    assert.equal(assertions.length, 1);

    nowMs += 30 * 60 * 1000;
    assert.equal(await source.getAccessToken(), "test-oauth-token-2");
    assert.equal(assertions.length, 2);
  });

  it("classifies OAuth token endpoint rejections as credentialsRejected", async () => {
    const credentials = parseGoogleServiceAccountJson(makeServiceAccountJson());
    const source = createGoogleAccessTokenSource({
      credentials,
      scopes: [CHAT_BOT_SCOPE],
      fetch: async () =>
        Response.json(
          { error: "invalid_grant", error_description: "Invalid JWT Signature." },
          { status: 400 },
        ),
    });

    await assert.rejects(
      () => source.getAccessToken(),
      (error: unknown) => {
        assert(error instanceof GoogleAccessTokenError);
        assert.equal(error.code, "credentialsRejected");
        assert.equal(error.status, 400);
        return true;
      },
    );
  });
});
