import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import { FakeGitHub, fakeGitHubConnectionClient } from "../../test-utils/fake-github.js";
import { createGitHubConnectionClient, type GitHubConnectionClient } from "./client.js";

const HUB = "https://hub.example.test";

function github(options: { extraOrganizations?: number } = {}) {
  const fake = new FakeGitHub({
    webBaseUrl: "https://github.test",
    hubOrigin: () => HUB,
    ...options,
  });
  return { fake, client: fakeGitHubConnectionClient(fake, HUB) };
}

/** Authorizes the signed-in person and lists what Hub's client sees through their token. */
async function userInstallations(fake: FakeGitHub, client: GitHubConnectionClient) {
  const verifier = "verifier-".padEnd(48, "x");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const back = fake.authorize(client.authorizationUrl({ state: "state", challenge }));
  const code = back.searchParams.get("code");
  assert.ok(code);
  return client.userInstallations({ code, verifier });
}

function summary(installations: Awaited<ReturnType<typeof userInstallations>>) {
  return installations?.map(({ identity, ownership }) => ({
    account: identity.accountLogin,
    installationId: identity.installationId,
    ownership: ownership.status,
  }));
}

describe("GitHub connection client", () => {
  it("lists the installations a person can see with whether they own each account", async () => {
    const { fake, client } = github();
    fake.command({ op: "install", account: "acme-inc" });
    fake.command({ op: "install", account: "octo" });
    fake.command({ op: "install", account: "mona" });

    assert.deepEqual(summary(await userInstallations(fake, client)), [
      { account: "acme-inc", installationId: 42, ownership: "owner" },
      { account: "octo", installationId: 77, ownership: "owner" },
    ]);

    fake.command({ op: "signIn", login: "mona" });
    assert.deepEqual(summary(await userInstallations(fake, client)), [
      { account: "acme-inc", installationId: 42, ownership: "notOwner" },
      { account: "mona", installationId: 78, ownership: "owner" },
    ]);
  });

  it("asks GitHub whether the person administers an organization, with no organization permission", async () => {
    const { fake, client } = github();
    fake.command({ op: "install", account: "acme-inc" });

    assert.deepEqual(summary(await userInstallations(fake, client)), [
      { account: "acme-inc", installationId: 42, ownership: "owner" },
    ]);
    fake.command({ op: "signIn", login: "mona" });
    assert.deepEqual(summary(await userInstallations(fake, client)), [
      { account: "acme-inc", installationId: 42, ownership: "notOwner" },
    ]);
    assert.ok(fake.apiRequests.includes("/graphql"));
    assert.ok(!fake.apiRequests.some((path) => path.startsWith("/user/memberships")));
  });

  it("fails instead of answering not-owner when GitHub cannot say", async () => {
    const { fake, client } = github();
    fake.command({ op: "install", account: "acme-inc" });
    fake.command({ op: "graphqlOutage", down: true });

    await assert.rejects(userInstallations(fake, client), /github organization administration/u);
  });

  it("lists every page of installations", async () => {
    const { fake, client } = github({ extraOrganizations: 101 });
    fake.command({ op: "install", account: "acme-inc" });

    const installations = (await userInstallations(fake, client)) ?? [];

    assert.equal(installations.length, 102);
    assert.ok(installations.every(({ ownership }) => ownership.status === "owner"));
    assert.deepEqual(fake.apiRequests.filter((path) => path === "/user/installations").length, 2);
  });

  it("answers undefined when GitHub refuses the authorization code", async () => {
    const { client } = github();

    assert.equal(
      await client.userInstallations({ code: "never-issued", verifier: "verifier" }),
      undefined,
    );
  });

  it("returns exact App absence without converting transient failure to absence", async () => {
    const { fake, client } = github();
    assert.deepEqual(await client.getInstallation(42), { status: "absent" });
    fake.command({ op: "install", account: "acme-inc" });
    assert.deepEqual(await client.getInstallation(42), {
      status: "present",
      identity: {
        installationId: 42,
        accountId: "420",
        accountLogin: "acme-inc",
        accountType: "Organization",
        status: "active",
      },
    });

    const failing = createGitHubConnectionClient({
      publicBaseUrl: HUB,
      appSlug: "paseo",
      clientId: "client",
      clientSecret: "secret",
      appAuth: {
        ...fake.appAuth,
        getInstallation: () => Promise.reject(new Error("provider unavailable")),
      },
      fetch: fake.fetch,
      ...fake.clientUrls(),
    });
    await assert.rejects(failing.getInstallation(42), /provider unavailable/u);
  });
});
