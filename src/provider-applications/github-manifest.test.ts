import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  GITHUB_MANIFEST_CALLBACK_PATH,
  GITHUB_MANIFEST_EVENTS,
  GITHUB_MANIFEST_PERMISSIONS,
  GitHubManifestConversionError,
  createGitHubAppManifest,
  createGitHubManifestClient,
  githubManifestRegistrationAction,
} from "./github-manifest.js";

describe("GitHub App manifest", () => {
  it("uses Hub's existing callback, setup, permission, and event contracts on HTTPS", () => {
    const manifest = createGitHubAppManifest("https://hub.example.test");

    assert.deepEqual(manifest.default_permissions, GITHUB_MANIFEST_PERMISSIONS);
    assert.deepEqual(manifest.default_events, GITHUB_MANIFEST_EVENTS);
    assert.deepEqual(manifest.hook_attributes, {
      url: "https://hub.example.test/webhook",
      active: true,
    });
    assert.equal(manifest.redirect_url, `https://hub.example.test${GITHUB_MANIFEST_CALLBACK_PATH}`);
    assert.deepEqual(manifest.callback_urls, [
      "https://hub.example.test/api/integrations/github/callback",
    ]);
    assert.equal(manifest.setup_url, "https://hub.example.test/api/integrations/github/setup");
    assert.equal(manifest.public, false);
  });

  it("omits webhook configuration on a non-HTTPS origin without withholding repository access", () => {
    const manifest = createGitHubAppManifest("http://hub.example.test");

    assert.equal(manifest.hook_attributes, undefined);
    assert.equal(manifest.default_events, undefined);
    assert.deepEqual(manifest.default_permissions, GITHUB_MANIFEST_PERMISSIONS);
  });

  it("targets personal and organization registration endpoints", () => {
    assert.equal(githubManifestRegistrationAction(), "https://github.com/settings/apps/new");
    assert.equal(
      githubManifestRegistrationAction("paseo-team"),
      "https://github.com/organizations/paseo-team/settings/apps/new",
    );
  });

  it("converts GitHub's secret-bearing response without exposing an unparsed payload", async () => {
    const requests: Request[] = [];
    const client = createGitHubManifestClient({
      apiBaseUrl: "https://api.example.test",
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          Response.json({
            id: 42,
            slug: "paseo",
            name: "Paseo Hub",
            owner: { login: "acme" },
            client_id: "client",
            client_secret: "client-secret",
            webhook_secret: "webhook-secret",
            pem: "private-key",
            ignored: "never returned",
          }),
        );
      },
    });

    assert.deepEqual(await client.convert("temporary-code"), {
      appId: "42",
      appSlug: "paseo",
      name: "Paseo Hub",
      ownerLogin: "acme",
      clientId: "client",
      clientSecret: "client-secret",
      privateKey: "private-key",
      webhookSecret: "webhook-secret",
    });
    assert.equal(
      requests[0]?.url,
      "https://api.example.test/app-manifests/temporary-code/conversions",
    );
    assert.equal(requests[0]?.method, "POST");
  });

  it("classifies rejected and malformed conversion responses without including body content", async () => {
    const rejected = createGitHubManifestClient({
      fetch: () => Promise.resolve(new Response("private-key", { status: 422 })),
    });
    await assert.rejects(
      () => rejected.convert("code"),
      (error: unknown) =>
        error instanceof GitHubManifestConversionError &&
        error.status === 422 &&
        !error.message.includes("private-key"),
    );

    const malformed = createGitHubManifestClient({
      fetch: () => Promise.resolve(Response.json({})),
    });
    await assert.rejects(
      () => malformed.convert("code"),
      (error: unknown) => error instanceof GitHubManifestConversionError && error.status === 502,
    );
  });
});
