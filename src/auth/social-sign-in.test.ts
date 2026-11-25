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
    assert.equal(signIn.google?.clientId, "google-id");
    assert.equal(signIn.google?.clientSecret, "google-secret");
    assert.deepEqual(signIn.github, { clientId: "github-id", clientSecret: "github-secret" });
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

  it("counts a Google address as verified only where Google hosts it", async () => {
    const google = readSocialSignIn({
      PASEO_AUTH_GOOGLE_CLIENT_ID: "google-id",
      PASEO_AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
    }).google!;
    const verified = async (claims: { email: string; email_verified: boolean; hd?: string }) =>
      (await google.mapProfileToUser!({ ...GOOGLE_PROFILE, ...claims })).emailVerified;
    assert.equal(await verified({ email: "person@gmail.com", email_verified: true }), true);
    assert.equal(
      await verified({ email: "person@company.test", email_verified: true, hd: "company.test" }),
      true,
    );
    assert.equal(await verified({ email: "person@company.test", email_verified: true }), false);
    assert.equal(await verified({ email: "person@gmail.com", email_verified: false }), false);
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

const GOOGLE_PROFILE = {
  aud: "google-id",
  azp: "google-id",
  exp: 0,
  family_name: "Person",
  given_name: "Google",
  iat: 0,
  iss: "https://accounts.google.com",
  jti: "token",
  locale: "en",
  name: "Google Person",
  nbf: 0,
  picture: "",
  sub: "google-person",
};
