import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { HubConfigSchema, type HubConfig } from "../../config/index.js";
import { matchTriggers } from "./match.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";

describe("matchTriggers", () => {
  it("matches provider namespaced issue comment triggers by repo, text, and actor", () => {
    const config = HubConfigSchema.parse({
      environments: [{ name: "hetzner-faro", kind: "daemon", daemon: "mob-hetzner", cwd: "/repo" }],
      triggers: [
        {
          name: "faro-mention",
          on: "github.issue_comment",
          environment: "hetzner-faro",
          filters: {
            repo: "boudra/faro",
            contains: "@paseo",
            from_users: ["boudra"],
          },
          agent: { provider: "claude/opus", mode: "bypassPermissions" },
          prompt: "Handle it",
        },
      ],
    });

    const matches = matchTriggers(config, createEvent());

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.trigger.name, "faro-mention");
  });

  it("matches pattern-less issue comments by repo and from_users", () => {
    const config = HubConfigSchema.parse({
      environments: [{ name: "hetzner-faro", kind: "daemon", daemon: "mob-hetzner", cwd: "/repo" }],
      triggers: [
        {
          name: "faro-any-comment",
          on: "github.issue_comment",
          environment: "hetzner-faro",
          filters: {
            repo: "boudra/faro",
            from_users: ["boudra"],
          },
          agent: { provider: "claude/opus", mode: "bypassPermissions" },
          prompt: "Handle ${{ paseo.event.github.comment.body }}",
        },
      ],
    });

    const matches = matchTriggers(
      config,
      createEvent({
        payload: {
          comment: { id: 123, body: "please explain this failure", user: { login: "boudra" } },
          sender: { login: "boudra" },
        },
      }),
    );

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.trigger.name, "faro-any-comment");
  });

  it("rejects pattern-less issue comments from users outside from_users", () => {
    const config = HubConfigSchema.parse({
      environments: [{ name: "hetzner-faro", kind: "daemon", daemon: "mob-hetzner", cwd: "/repo" }],
      triggers: [
        {
          name: "faro-any-comment",
          on: "github.issue_comment",
          environment: "hetzner-faro",
          filters: {
            repo: "boudra/faro",
            from_users: ["boudra"],
          },
          agent: { provider: "claude/opus", mode: "bypassPermissions" },
          prompt: "Handle ${{ paseo.event.github.comment.body }}",
        },
      ],
    });

    assert.deepEqual(
      matchTriggers(
        config,
        createEvent({
          payload: {
            comment: { id: 123, body: "please explain", user: { login: "paseo-ai" } },
            sender: { login: "paseo-ai" },
          },
        }),
      ),
      [],
    );
  });

  it("keeps explicit pattern filters as literal prefix checks", () => {
    const config = HubConfigSchema.parse({
      environments: [{ name: "hetzner-faro", kind: "daemon", daemon: "mob-hetzner", cwd: "/repo" }],
      triggers: [
        {
          name: "faro-pattern",
          on: "github.issue_comment",
          environment: "hetzner-faro",
          filters: {
            repo: "boudra/faro",
            pattern: "@paseo",
            from_users: ["boudra"],
          },
          agent: { provider: "claude/opus", mode: "bypassPermissions" },
          prompt: "Handle it",
        },
      ],
    });

    assert.equal(
      matchTriggers(
        config,
        createEvent({
          payload: {
            comment: { id: 123, body: "@paseo please explain", user: { login: "boudra" } },
            sender: { login: "boudra" },
          },
        }),
      ).length,
      1,
    );
    assert.deepEqual(matchTriggers(config, createEvent()), []);
  });

  it("does not match a different repo", () => {
    const config = HubConfigSchema.parse({
      environments: [{ name: "hetzner-faro", kind: "daemon", daemon: "mob-hetzner", cwd: "/repo" }],
      triggers: [
        {
          name: "faro-mention",
          on: "github.issue_comment",
          environment: "hetzner-faro",
          filters: { repo: "elsewhere/repo", contains: "@paseo", from_users: ["boudra"] },
          agent: { provider: "claude/opus", mode: "bypassPermissions" },
          prompt: "Handle it",
        },
      ],
    });

    assert.deepEqual(matchTriggers(config, createEvent()), []);
  });

  it("matches pull request review comments", () => {
    const config = HubConfigSchema.parse({
      environments: [{ name: "hetzner-faro", kind: "daemon", daemon: "mob-hetzner", cwd: "/repo" }],
      triggers: [
        {
          name: "review-comment",
          on: "github.pull_request_review_comment",
          environment: "hetzner-faro",
          filters: { contains: "please", from_users: ["boudra"] },
          agent: { provider: "claude/opus", mode: "bypassPermissions" },
          prompt: "Handle it",
        },
      ],
    });

    const matches = matchTriggers(
      config,
      createEvent({
        type: "pull_request_review_comment",
        payload: { comment: { id: 7, body: "please check", user: { login: "boudra" } } },
      }),
    );

    assert.equal(matches.length, 1);
  });

  it("denies when from_users is missing even if schema validation was bypassed", () => {
    const config: HubConfig = {
      environments: [{ name: "hetzner-faro", kind: "daemon", daemon: "mob-hetzner", cwd: "/repo" }],
      triggers: [
        {
          name: "legacy-open-trigger",
          on: "github.issue_comment",
          environment: "hetzner-faro",
          filters: { repo: "boudra/faro", contains: "@paseo" },
          agent: { provider: "claude/opus", mode: "bypassPermissions" },
          prompt: { value: "Handle it", ast: [{ kind: "literal", value: "Handle it" }] },
          timeout: "30m",
          idle_timeout: "5m",
          auto_archive: false,
        },
      ],
    };

    assert.deepEqual(
      matchTriggers(
        config,
        createEvent({
          payload: {
            comment: { id: 123, body: "hi @paseo", user: { login: "anyone" } },
            sender: { login: "anyone" },
          },
        }),
      ),
      [],
    );
  });
});

function createEvent(
  options: {
    type?: string;
    payload?: Record<string, unknown>;
  } = {},
): NormalizedGitHubEvent {
  return {
    id: "delivery-1",
    type: options.type ?? "issue_comment",
    repo: "boudra/faro",
    repositoryId: 7,
    installationId: 42,
    payload: options.payload ?? {
      comment: { id: 123, body: "hi @paseo", user: { login: "boudra" } },
      sender: { login: "boudra" },
    },
    createdAt: "2026-05-19T00:00:00.000Z",
  };
}
