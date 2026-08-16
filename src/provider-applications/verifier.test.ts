import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "vitest";
import { ProviderVerificationError, createProviderApplicationVerifier } from "./index.js";

describe("provider application verification", () => {
  it("authenticates a GitHub App against the fixed API endpoint and returns its identity", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const requests: string[] = [];
    const verifier = createProviderApplicationVerifier({
      now: () => Date.parse("2026-08-14T12:00:00Z"),
      fetch: (input, init) => {
        requests.push(requestUrl(input));
        assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer /u);
        return Promise.resolve(
          Response.json({ id: 42, name: "Paseo Hub", owner: { login: "acme" } }),
        );
      },
    });

    assert.deepEqual(
      await verifier.verify("github", {
        provider: "github",
        appId: "42",
        appSlug: "paseo",
        clientId: "client",
        clientSecret: "secret",
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        webhookSecret: "webhook",
      }),
      { provider: "github", id: "42", name: "Paseo Hub", ownerLogin: "acme" },
    );
    assert.deepEqual(requests, ["https://api.github.com/app"]);
  });

  it("proves the Discord bot identity and rejects a different application", async () => {
    const verifier = createProviderApplicationVerifier({
      fetch: () => Promise.resolve(Response.json({ id: "100", username: "Paseo", bot: true })),
    });
    const configuration = {
      provider: "discord" as const,
      applicationId: "100",
      clientSecret: "secret",
      botToken: "token",
    };
    assert.deepEqual(await verifier.verify("discord", configuration), {
      provider: "discord",
      id: "100",
      name: "Paseo",
    });
    await assert.rejects(
      verifier.verify("discord", { ...configuration, applicationId: "200" }),
      (error: unknown) =>
        error instanceof ProviderVerificationError && error.reason === "credentialsRejected",
    );
  });

  it("projects transport failures without returning upstream details", async () => {
    const verifier = createProviderApplicationVerifier({
      fetch: () => Promise.reject(new Error("token=super-secret")),
    });
    await assert.rejects(
      verifier.verify("discord", {
        provider: "discord",
        applicationId: "100",
        clientSecret: "secret",
        botToken: "super-secret",
      }),
      (error: unknown) =>
        error instanceof ProviderVerificationError &&
        error.reason === "network" &&
        !error.message.includes("super-secret") &&
        !(error.cause instanceof Error && error.cause.message.includes("super-secret")),
    );
  });

  for (const [status, reason] of [
    [429, "rateLimited"],
    [503, "upstreamUnavailable"],
  ] as const) {
    it(`classifies Discord HTTP ${status} without reading its sensitive payload`, async () => {
      let bodyRead = false;
      const response = new Response(null, { status });
      Object.defineProperty(response, "json", {
        value: () => {
          bodyRead = true;
          return Promise.resolve({ payload: "PRIVATE-UPSTREAM-PAYLOAD" });
        },
      });
      const verifier = createProviderApplicationVerifier({
        fetch: () => Promise.resolve(response),
      });
      await assert.rejects(
        verifier.verify("discord", {
          provider: "discord",
          applicationId: "100",
          clientSecret: "PRIVATE-CLIENT-SECRET",
          botToken: "PRIVATE-BOT-TOKEN",
        }),
        (error: unknown) =>
          error instanceof ProviderVerificationError &&
          error.reason === reason &&
          error.safeStatus === status,
      );
      assert.equal(bodyRead, false);
    });
  }

  it("classifies a successful response with invalid JSON separately", async () => {
    const verifier = createProviderApplicationVerifier({
      fetch: () => Promise.resolve(new Response("not-json", { status: 200 })),
    });
    await assert.rejects(
      verifier.verify("discord", {
        provider: "discord",
        applicationId: "100",
        clientSecret: "secret",
        botToken: "token",
      }),
      (error: unknown) =>
        error instanceof ProviderVerificationError && error.reason === "invalidResponse",
    );
  });
});

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}
