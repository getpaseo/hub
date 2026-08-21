import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { matchTriggers } from "./match.js";
import type { GitHubTeamMembershipClient } from "./team-membership.js";

describe("GitHub trigger matching", () => {
  it("matches the compiled one-step trigger by repository, text, and actor", async () => {
    const config = configFor({ repo: "boudra/faro", contains: "@paseo", from_users: ["boudra"] });
    const matches = await matchTriggers(config, createEvent(), { teamMemberships: denyTeams });

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.trigger.name, "github-comment");
  });

  it("matches pattern-less comments while preserving the provider allowlist", async () => {
    const config = configFor({ repo: "boudra/faro", from_users: ["boudra"] });
    assert.equal(
      (
        await matchTriggers(
          config,
          createEvent({
            payload: {
              comment: { id: 123, body: "please explain", user: { login: "boudra" } },
              sender: { login: "boudra" },
            },
          }),
          { teamMemberships: denyTeams },
        )
      ).length,
      1,
    );
    assert.deepEqual(
      await matchTriggers(
        config,
        createEvent({
          payload: {
            comment: { id: 123, body: "please explain", user: { login: "stranger" } },
            sender: { login: "stranger" },
          },
        }),
        { teamMemberships: denyTeams },
      ),
      [],
    );
  });

  it("keeps repository and pattern filters literal", async () => {
    const config = configFor({ repo: "boudra/faro", pattern: "@paseo", from_users: ["boudra"] });
    assert.equal(
      (
        await matchTriggers(
          config,
          createEvent({
            payload: {
              comment: { id: 123, body: "@paseo please explain", user: { login: "boudra" } },
              sender: { login: "boudra" },
            },
          }),
          { teamMemberships: denyTeams },
        )
      ).length,
      1,
    );
    assert.deepEqual(
      await matchTriggers(config, createEvent({ repo: "elsewhere/repo" }), {
        teamMemberships: denyTeams,
      }),
      [],
    );
    assert.deepEqual(
      await matchTriggers(
        config,
        createEvent({
          payload: {
            comment: { id: 123, body: "please explain", user: { login: "boudra" } },
            sender: { login: "boudra" },
          },
        }),
        { teamMemberships: denyTeams },
      ),
      [],
    );
  });

  it("applies the same security filters to pull-request review comments", async () => {
    const config = compileHubConfig({
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "review-comment",
          on: "github.pull_request_review_comment",
          max_runtime: "2h",
          filters: { repo: "boudra/faro", contains: "@paseo", from_users: ["boudra"] },
          steps: [
            {
              id: "reply",
              environment: "runner",
              max_runtime: "1h",
              idle_timeout: "5m",
              agent: { provider: "opencode", mode: "default" },
              prompt: [{ text: "Handle it" }],
            },
          ],
        },
      ],
    });
    const event: NormalizedGitHubEvent = {
      ...createEvent(),
      type: "pull_request_review_comment",
      payload: {
        comment: { id: 999, body: "@paseo review this", user: { login: "boudra" } },
        sender: { login: "boudra" },
        pull_request: { head: { ref: "topic" } },
      },
    };
    assert.equal((await matchTriggers(config, event, { teamMemberships: denyTeams })).length, 1);
  });

  it("allows an active GitHub team member and fails closed when membership is unavailable", async () => {
    const config = configFor({
      repo: "boudra/faro",
      contains: "@paseo",
      from_teams: ["boudra/maintainers"],
    });
    const activeTeams = new TestTeamMemberships(true);

    assert.equal(
      (
        await matchTriggers(config, createEvent(), {
          teamMemberships: activeTeams,
        })
      ).length,
      1,
    );
    assert.deepEqual(activeTeams.checks, [
      {
        installationId: 42,
        organization: "boudra",
        teamSlug: "maintainers",
        username: "boudra",
      },
    ]);
    assert.deepEqual(
      await matchTriggers(config, createEvent(), { teamMemberships: denyTeams }),
      [],
    );
  });

  it("treats user and team allowlists as alternatives", async () => {
    const config = configFor({
      repo: "boudra/faro",
      contains: "@paseo",
      from_users: ["boudra"],
      from_teams: ["boudra/maintainers"],
    });
    const memberships = new TestTeamMemberships(false);

    assert.equal(
      (await matchTriggers(config, createEvent(), { teamMemberships: memberships })).length,
      1,
    );
    assert.deepEqual(memberships.checks, []);
  });
});

const denyTeams: GitHubTeamMembershipClient = {
  isActiveMember: async () => false,
};

class TestTeamMemberships implements GitHubTeamMembershipClient {
  readonly checks: Array<Parameters<GitHubTeamMembershipClient["isActiveMember"]>[0]> = [];

  constructor(private readonly active: boolean) {}

  async isActiveMember(input: Parameters<GitHubTeamMembershipClient["isActiveMember"]>[0]) {
    this.checks.push(input);
    return this.active;
  }
}

function configFor(filters: Record<string, unknown>) {
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "github-comment",
        on: "github.issue_comment",
        max_runtime: "2h",
        filters,
        steps: [
          {
            id: "reply",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "default" },
            prompt: [{ text: "Handle it" }],
          },
        ],
      },
    ],
  });
}

function createEvent(
  options: {
    repo?: string;
    payload?: Record<string, unknown>;
  } = {},
): NormalizedGitHubEvent {
  return {
    id: "delivery-1",
    type: "issue_comment",
    repo: options.repo ?? "boudra/faro",
    repositoryId: 7,
    installationId: 42,
    payload: options.payload ?? {
      comment: { id: 123, body: "hi @paseo", user: { login: "boudra" } },
      sender: { login: "boudra" },
    },
    createdAt: "2026-05-19T00:00:00.000Z",
  };
}
