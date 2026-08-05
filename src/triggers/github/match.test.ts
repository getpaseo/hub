import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { matchTriggers } from "./match.js";

describe("GitHub trigger matching", () => {
  it("matches the compiled one-step trigger by repository, text, and actor", () => {
    const config = configFor({ repo: "boudra/faro", contains: "@paseo", from_users: ["boudra"] });
    const matches = matchTriggers(config, createEvent());

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.trigger.name, "github-comment");
  });

  it("matches pattern-less comments while preserving the provider allowlist", () => {
    const config = configFor({ repo: "boudra/faro", from_users: ["boudra"] });
    assert.equal(
      matchTriggers(
        config,
        createEvent({
          payload: {
            comment: { id: 123, body: "please explain", user: { login: "boudra" } },
            sender: { login: "boudra" },
          },
        }),
      ).length,
      1,
    );
    assert.deepEqual(
      matchTriggers(
        config,
        createEvent({
          payload: {
            comment: { id: 123, body: "please explain", user: { login: "stranger" } },
            sender: { login: "stranger" },
          },
        }),
      ),
      [],
    );
  });

  it("keeps repository and pattern filters literal", () => {
    const config = configFor({ repo: "boudra/faro", pattern: "@paseo", from_users: ["boudra"] });
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
    assert.deepEqual(matchTriggers(config, createEvent({ repo: "elsewhere/repo" })), []);
    assert.deepEqual(
      matchTriggers(
        config,
        createEvent({
          payload: {
            comment: { id: 123, body: "please explain", user: { login: "boudra" } },
            sender: { login: "boudra" },
          },
        }),
      ),
      [],
    );
  });
});

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
