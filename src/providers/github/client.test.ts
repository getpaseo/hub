import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { GitHubProviderPort, githubInstallation } from "../../test-utils/github-connection.js";
import { createGitHubConnectionClient } from "./client.js";

describe("GitHub connection client", () => {
  it("finds an accessible installation after the first full page", async () => {
    const github = new GitHubProviderPort({ installation: githubInstallation(142) });
    const provider = createGitHubConnectionClient(github.options());

    const identity = await provider.verifyUserInstallation({
      code: "code",
      verifier: "verifier",
      installationId: 142,
    });

    assert.deepEqual(identity, {
      installationId: 142,
      accountId: "501",
      accountLogin: "acme",
      accountType: "Organization",
      status: "active",
    });
    assert.deepEqual(github.userInstallationPages, [1, 2]);
  });

  for (const membership of [
    { role: "member", state: "active" },
    { role: "admin", state: "pending" },
    { role: "admin", state: "active", status: 404 },
    { role: "admin", state: "active", status: 403 },
  ]) {
    it(`rejects installation access without active organization admin authority: ${JSON.stringify(membership)}`, async () => {
      const github = new GitHubProviderPort({ installation: githubInstallation(142), membership });
      assert.equal(
        await createGitHubConnectionClient(github.options()).verifyUserInstallation({
          code: "code",
          verifier: "verifier",
          installationId: 142,
        }),
        undefined,
      );
    });
  }

  it("requires the authenticated user to own a user-account installation", async () => {
    const installation = {
      ...githubInstallation(142),
      account: { id: 501, login: "owner", type: "User" },
    };
    for (const userId of [501, 999]) {
      const github = new GitHubProviderPort({ installation, userId });
      const result = await createGitHubConnectionClient(github.options()).verifyUserInstallation({
        code: "code",
        verifier: "verifier",
        installationId: 142,
      });
      assert.equal(result?.accountId, userId === 501 ? "501" : undefined);
    }
  });

  it("returns exact App absence without converting transient failure to absence", async () => {
    const absent = new GitHubProviderPort({ installation: undefined });
    const unavailable = new GitHubProviderPort({ appFailure: new Error("provider unavailable") });

    assert.equal(
      await createGitHubConnectionClient(absent.options()).verifyUserInstallation({
        code: "code",
        verifier: "verifier",
        installationId: 142,
      }),
      undefined,
    );
    await assert.rejects(
      createGitHubConnectionClient(unavailable.options()).verifyUserInstallation({
        code: "code",
        verifier: "verifier",
        installationId: 142,
      }),
      /provider unavailable/u,
    );
  });
});
