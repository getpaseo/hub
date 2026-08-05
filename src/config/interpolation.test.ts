import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { interpolateRecord, interpolateTemplate, interpolateWorktree } from "./interpolation.js";
import { parseEnvironmentTemplate } from "./environment-template.js";
import type { WorktreeTarget } from "./schema.js";

describe("interpolation", () => {
  it("resolves event paths into surrounding literals", async () => {
    const template = parseEnvironmentTemplate(
      "Handle ${{ paseo.event.github.comment.body }} from ${{ paseo.event.github.sender.login }}",
    );

    const result = await interpolateTemplate(template, {
      event: {
        github: {
          comment: { body: "hello @paseo" },
          sender: { login: "boudra" },
        },
      },
      connections: () => "unused",
    });

    assert.equal(result, "Handle hello @paseo from boudra");
  });

  it("stringifies non-string event values without escaping printable JSON", async () => {
    const template = parseEnvironmentTemplate(
      "issue=${{ paseo.event.github.issue.number }} draft=${{ paseo.event.github.issue.draft }} payload=${{ paseo.event.github.issue.labels }}",
    );

    const result = await interpolateTemplate(template, {
      event: {
        github: { issue: { number: 17, draft: false, labels: ["bug", "p1"] } },
      },
      connections: () => "unused",
    });

    assert.equal(result, 'issue=17 draft=false payload=["bug","p1"]');
  });

  it("throws a useful error when an event path is missing", async () => {
    const template = parseEnvironmentTemplate("body=${{ paseo.event.github.comment.body }}");

    await assert.rejects(
      () =>
        interpolateTemplate(template, {
          event: { github: { comment: null } },
          connections: () => "unused",
        }),
      /event path missing/u,
    );
  });

  it("invokes the matching integration resolver with the requested value", async () => {
    const template = parseEnvironmentTemplate(
      "token=${{ paseo.connections.getpaseo-github.token }}",
    );
    const calls: string[] = [];

    const result = await interpolateTemplate(template, {
      event: {},
      connections(slug, value) {
        assert.equal(slug, "getpaseo-github");
        calls.push(value);
        return "ghs_installation_token";
      },
    });

    assert.equal(result, "token=ghs_installation_token");
    assert.deepEqual(calls, ["token"]);
  });

  it("supports async integration resolvers", async () => {
    const template = parseEnvironmentTemplate("${{ paseo.connections.getpaseo-github.token }}");

    const result = await interpolateTemplate(template, {
      event: {},
      connections: async (slug, value) => {
        assert.equal(slug, "getpaseo-github");
        assert.equal(value, "token");
        return "ghs_async_token";
      },
    });

    assert.equal(result, "ghs_async_token");
  });

  it("fails loudly when a referenced connection slug is unavailable", async () => {
    const template = parseEnvironmentTemplate("${{ paseo.connections.getpaseo-discord.token }}");

    await assert.rejects(
      () =>
        interpolateTemplate(template, {
          event: {},
          connections: () => {
            throw new Error("connection slug is unavailable");
          },
        }),
      /connection slug is unavailable/u,
    );
  });

  it("interpolates a record of templates in parallel", async () => {
    const env = {
      GITHUB_TOKEN: parseEnvironmentTemplate("${{ paseo.connections.getpaseo-github.token }}"),
      ISSUE: parseEnvironmentTemplate("issue-${{ paseo.event.github.issue.number }}"),
    };

    const result = await interpolateRecord(env, {
      event: { github: { issue: { number: 211 } } },
      connections: () => "ghs_token_xyz",
    });

    assert.deepEqual(result, {
      GITHUB_TOKEN: "ghs_token_xyz",
      ISSUE: "issue-211",
    });
  });

  it.each([
    [
      {
        mode: "branch-off",
        newBranch: "event-${{ paseo.event.slack.trigger_message.body }}",
        base: "base-${{ paseo.event.slack.trigger_message.ts }}",
      },
      { mode: "branch-off", newBranch: "event-deploy", base: "base-123.456" },
    ],
    [
      {
        mode: "checkout-branch",
        branch: "event-${{ paseo.event.slack.trigger_message.body }}",
      },
      { mode: "checkout-branch", branch: "event-deploy" },
    ],
  ] as const)("interpolates worktree template mode %#", async (worktree, expected) => {
    assert.deepEqual(
      await interpolateWorktree(worktree as WorktreeTarget, {
        event: { slack: { trigger_message: { body: "deploy", ts: "123.456" } } },
        connections: () => {
          throw new Error("connection resolver unavailable");
        },
      }),
      expected,
    );
  });
});
