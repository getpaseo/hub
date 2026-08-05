import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { HubConfigSchema, parseTriggerTimeoutMs } from "./schema.js";

describe("HubConfigSchema", () => {
  it("parses daemon environments, provider namespaced triggers, outputs, and merge ASTs", () => {
    const parsed = HubConfigSchema.parse({
      environments: [
        {
          name: "hetzner-faro",
          kind: "daemon",
          daemon: "mob-hetzner",
          cwd: "/home/moboudra/dev/faro",
        },
      ],
      triggers: [
        {
          name: "faro-mention",
          on: "github.issue_comment",
          environment: "hetzner-faro",
          filters: {
            repo: "boudra/faro",
            pattern: "@paseo",
            from_users: ["boudra"],
          },
          agent: {
            provider: "codex",
            model: "gpt-5.6-sol",
            mode: "full-access",
            thinkingOptionId: "xhigh",
          },
          prompt: "Handle ${{ paseo.event.github.comment.body }}",
          env: {
            GITHUB_TOKEN: "${{ paseo.connections.getpaseo-github.token }}",
          },
          allow_outputs: [{ type: "discord.reply", max: 5 }],
        },
      ],
    });

    assert.equal(parsed.triggers[0]?.prompt.ast[1]?.kind, "event");
    assert.deepEqual(parsed.triggers[0]?.env?.["GITHUB_TOKEN"]?.ast, [
      {
        kind: "connection",
        slug: "getpaseo-github",
        value: "token",
        raw: "${{ paseo.connections.getpaseo-github.token }}",
      },
    ]);
    assert.deepEqual(parsed.triggers[0]?.allow_outputs, [{ type: "discord.reply", max: 5 }]);
    assert.deepEqual(parsed.triggers[0]?.agent, {
      provider: "codex",
      model: "gpt-5.6-sol",
      mode: "full-access",
      thinkingOptionId: "xhigh",
    });
  });

  it("rejects triggers with no from_users filter", () => {
    const parsed = HubConfigSchema.safeParse(createConfig({ repo: "boudra/faro" }));

    assert.equal(parsed.success, false);
    assert.match(
      parsed.error?.issues[0]?.message ?? "",
      /trigger `faro-mention` is missing required `from_users` field, or the array is empty/,
    );
  });

  it("rejects the removed integrations interpolation namespace", () => {
    assert.throws(
      () =>
        HubConfigSchema.parse({
          environments: [{ name: "runner", kind: "docker", image: "paseo/test" }],
          triggers: [
            {
              ...createConfig({ repo: "boudra/faro", from_users: ["boudra"] }).triggers[0],
              prompt: "${{ paseo.integrations.github.token }}",
            },
          ],
        }),
      /unsupported merge variable/u,
    );
  });

  it("rejects triggers with an empty from_users filter", () => {
    const parsed = HubConfigSchema.safeParse(createConfig({ repo: "boudra/faro", from_users: [] }));

    assert.equal(parsed.success, false);
    assert.match(
      parsed.error?.issues[0]?.message ?? "",
      /trigger `faro-mention` is missing required `from_users` field, or the array is empty/,
    );
  });

  it("accepts triggers with at least one allowed user", () => {
    const parsed = HubConfigSchema.safeParse(
      createConfig({ repo: "boudra/faro", from_users: ["boudra"] }),
    );

    assert.equal(parsed.success, true);
  });

  it("rejects duplicate trigger names", () => {
    const config = createConfig({ repo: "boudra/faro", from_users: ["boudra"] });
    const duplicate = config.triggers[0];
    assert(duplicate !== undefined);

    const parsed = HubConfigSchema.safeParse({
      ...config,
      triggers: [...config.triggers, duplicate],
    });

    assert.equal(parsed.success, false);
    assert.match(parsed.error?.issues.at(-1)?.message ?? "", /trigger name must be unique/u);
  });

  it("defaults hard and idle timeouts and accepts YAML durations", () => {
    const defaulted = HubConfigSchema.parse(
      createConfig({ repo: "boudra/faro", from_users: ["boudra"] }),
    );
    const configured = HubConfigSchema.parse(
      createConfig({ repo: "boudra/faro", from_users: ["boudra"] }, "45m", "2m"),
    );

    assert.equal(defaulted.triggers[0]?.timeout, "1h");
    assert.equal(defaulted.triggers[0]?.idle_timeout, "5m");
    assert.equal(parseTriggerTimeoutMs(configured.triggers[0]?.timeout ?? ""), 2_700_000);
    assert.equal(parseTriggerTimeoutMs(configured.triggers[0]?.idle_timeout ?? ""), 120_000);
  });

  it("normalizes auto-archive as trigger policy", () => {
    const defaulted = HubConfigSchema.parse(
      createConfig({ repo: "boudra/faro", from_users: ["boudra"] }),
    );
    const configured = HubConfigSchema.parse(
      createConfig({ repo: "boudra/faro", from_users: ["boudra"] }, undefined, undefined, true),
    );

    assert.equal(defaulted.triggers[0]?.auto_archive, false);
    assert.equal(configured.triggers[0]?.auto_archive, true);
    assert.equal("auto_archive" in defaulted.environments[0]!, false);
  });

  it("rejects zero and invalid trigger timeouts", () => {
    for (const timeout of ["0m", "30", "forever"]) {
      assert.equal(
        HubConfigSchema.safeParse(
          createConfig({ repo: "boudra/faro", from_users: ["boudra"] }, timeout),
        ).success,
        false,
      );
    }
    assert.equal(
      HubConfigSchema.safeParse(
        createConfig({ repo: "boudra/faro", from_users: ["boudra"] }, "1h", "0m"),
      ).success,
      false,
    );
  });

  it("accepts discord mention triggers with a guild filter", () => {
    const parsed = HubConfigSchema.safeParse(
      createConfig({ guild: "guild-1", channels: ["channel-1"], from_users: ["boudra"] }),
    );

    assert.equal(parsed.success, true);
  });

  it("rejects the removed server filter instead of accepting an unroutable trigger", () => {
    const parsed = HubConfigSchema.safeParse(
      createConfig({ server: "guild-1", from_users: ["boudra"] }),
    );

    assert.equal(parsed.success, false);
  });

  it("accepts an optional kebab-case connection slug and rejects invalid slugs", () => {
    assert.equal(
      HubConfigSchema.safeParse(
        createConfig({ connection: "discord-main-1", guild: "guild-1", from_users: ["boudra"] }),
      ).success,
      true,
    );
    assert.equal(
      HubConfigSchema.safeParse(
        createConfig({ connection: "Discord Main", guild: "guild-1", from_users: ["boudra"] }),
      ).success,
      false,
    );
  });

  it("admits future fly and docker environments", () => {
    const parsed = HubConfigSchema.parse({
      environments: [
        { name: "fly-worker", kind: "fly", image: "registry/app:latest" },
        { name: "docker-worker", kind: "docker", image: "node:22" },
      ],
      triggers: [],
    });

    assert.deepEqual(
      parsed.environments.map((environment) => environment.kind),
      ["fly", "docker"],
    );
  });

  it("parses environment worktree targets without changing legacy config shape", () => {
    const parsed = HubConfigSchema.parse({
      environments: [
        {
          name: "paseo",
          kind: "daemon",
          daemon: "mob-hetzner",
          cwd: "/home/moboudra/dev/paseo",
          worktree: {
            mode: "branch-off",
            newBranch: "trigger-${{ paseo.event.github.delivery_id }}",
            base: "main",
          },
        },
      ],
      triggers: [],
    });

    assert.deepEqual(parsed.environments[0], {
      name: "paseo",
      kind: "daemon",
      daemon: "mob-hetzner",
      cwd: "/home/moboudra/dev/paseo",
      worktree: {
        mode: "branch-off",
        newBranch: "trigger-${{ paseo.event.github.delivery_id }}",
        base: "main",
      },
    });
  });
});

function createConfig(
  filters: Record<string, unknown>,
  timeout?: string,
  idleTimeout?: string,
  autoArchive?: boolean,
) {
  return {
    environments: [
      {
        name: "hetzner-faro",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/home/moboudra/dev/faro",
      },
    ],
    triggers: [
      {
        name: "faro-mention",
        on: "github.issue_comment",
        environment: "hetzner-faro",
        filters,
        agent: { provider: "claude/opus", mode: "bypassPermissions" },
        prompt: "Handle it",
        ...(timeout === undefined ? {} : { timeout }),
        ...(idleTimeout === undefined ? {} : { idle_timeout: idleTimeout }),
        ...(autoArchive === undefined ? {} : { auto_archive: autoArchive }),
      },
    ],
  };
}
