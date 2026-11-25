import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { configuredSocialProviders, readSocialSignIn } from "./social-sign-in.js";

describe("social sign-in configuration", () => {
  it("leaves every provider off when nothing is set", () => {
    const signIn = readSocialSignIn({});
    assert.deepEqual(signIn, {});
    assert.deepEqual(configuredSocialProviders(signIn), []);
    assert.deepEqual(
      readSocialSignIn({ PASEO_AUTH_GOOGLE_CLIENT_ID: " ", PASEO_AUTH_GOOGLE_CLIENT_SECRET: "" }),
      {},
    );
  });

  it("turns on each provider whose client is complete", () => {
    const signIn = readSocialSignIn({
      PASEO_AUTH_GOOGLE_CLIENT_ID: "google-id",
      PASEO_AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
      PASEO_AUTH_GITHUB_CLIENT_ID: "github-id",
      PASEO_AUTH_GITHUB_CLIENT_SECRET: "github-secret",
    });
    assert.deepEqual(signIn, {
      google: { clientId: "google-id", clientSecret: "google-secret" },
      github: { clientId: "github-id", clientSecret: "github-secret" },
    });
    assert.deepEqual(configuredSocialProviders(signIn), ["google", "github"]);
    assert.deepEqual(
      configuredSocialProviders(
        readSocialSignIn({
          PASEO_AUTH_GITHUB_CLIENT_ID: "github-id",
          PASEO_AUTH_GITHUB_CLIENT_SECRET: "github-secret",
        }),
      ),
      ["github"],
    );
  });

  it("fails startup when only half of a client is set", () => {
    assert.throws(
      () => readSocialSignIn({ PASEO_AUTH_GOOGLE_CLIENT_ID: "google-id" }),
      /PASEO_AUTH_GOOGLE_CLIENT_ID and PASEO_AUTH_GOOGLE_CLIENT_SECRET must be supplied together/u,
    );
    assert.throws(
      () => readSocialSignIn({ PASEO_AUTH_GITHUB_CLIENT_SECRET: "github-secret" }),
      /PASEO_AUTH_GITHUB_CLIENT_ID and PASEO_AUTH_GITHUB_CLIENT_SECRET must be supplied together/u,
    );
  });
});
