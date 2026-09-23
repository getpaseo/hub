import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  createGitHubTeamMembershipClient,
  type GitHubTeamMembershipAuth,
} from "./team-membership.js";

describe("GitHub team membership client", () => {
  it("accepts only active memberships", async () => {
    const harness = createHarness({ state: "active" });
    const client = createGitHubTeamMembershipClient(harness.auth);

    assert.equal(
      await client.isActiveMember({
        installationId: 42,
        organization: "getpaseo",
        teamSlug: "maintainers",
        username: "michael",
      }),
      true,
    );
    assert.deepEqual(harness.requests, [
      {
        route: "GET /orgs/{org}/teams/{team_slug}/memberships/{username}",
        parameters: {
          org: "getpaseo",
          team_slug: "maintainers",
          username: "michael",
          headers: { "x-github-api-version": "2026-03-10" },
        },
      },
    ]);
  });

  it.each([
    ["pending", { state: "pending" }],
    ["missing", httpError(404)],
    ["permission denied", httpError(403)],
  ])("fails closed for a %s team membership result", async (_name, result) => {
    const client = createGitHubTeamMembershipClient(createHarness(result).auth);

    assert.equal(
      await client.isActiveMember({
        installationId: 42,
        organization: "getpaseo",
        teamSlug: "maintainers",
        username: "michael",
      }),
      false,
    );
  });
});

function createHarness(result: unknown) {
  const requests: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  const auth = {
    createInstallationOctokit: async () => ({
      request: async (route: string, parameters: Record<string, unknown>) => {
        requests.push({ route, parameters });
        if (result instanceof Error) throw result;
        return { data: result };
      },
    }),
  } satisfies GitHubTeamMembershipAuth;
  return { auth, requests };
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`GitHub returned ${status}`), { status });
}
