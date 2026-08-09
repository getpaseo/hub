import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it } from "vitest";
import { compileHubBundle, type HubBundleFile } from "./bundle.js";

const fixtureRoot = join(process.cwd(), "src/config/fixtures/current-project");

describe("current project configuration proof", () => {
  it("compiles provider workflows without duplicated routing branches", async () => {
    const bundle = compileHubBundle(await fixtureFiles());
    assert.deepEqual(
      bundle.configuration.triggers.map(({ name, sourceFile }) => ({ name, sourceFile })),
      [
        { name: "discord-request", sourceFile: ".paseo/workflows/discord.yml" },
        { name: "github-hub", sourceFile: ".paseo/workflows/github-hub.yml" },
        { name: "github-paseo", sourceFile: ".paseo/workflows/github-paseo.yml" },
        { name: "slack-request", sourceFile: ".paseo/workflows/slack.yml" },
      ],
    );
    for (const provider of ["slack-request", "discord-request"]) {
      const trigger = bundle.configuration.triggers.find(({ name }) => name === provider)!;
      assert.deepEqual(
        trigger.steps.map(({ id }) => id),
        ["classify", "work"],
      );
      const worker = trigger.steps[1]!;
      assert.ok("selector" in worker.agent);
      if (!("selector" in worker.agent)) continue;
      assert.deepEqual(worker.agent.choices["codex"]?.options, {
        sandbox_workspace_write: {
          writable_roots: ["/var/cache/npm"],
          network_access: false,
        },
      });
      assert.deepEqual(worker.allowOutputs, [
        {
          type: provider.startsWith("slack") ? "slack.reply" : "discord.reply",
          max: 1,
          required: true,
        },
      ]);
    }
  });
});

async function fixtureFiles(): Promise<HubBundleFile[]> {
  const paseo = join(fixtureRoot, ".paseo");
  const workflow = join(paseo, "workflows");
  const partials = join(workflow, "partials");
  const workflowNames = (await readdir(workflow)).filter((name) => name.endsWith(".yml"));
  const partialNames = await readdir(partials);
  const paths = [
    join(paseo, "hub.yml"),
    ...workflowNames.map((name) => join(workflow, name)),
    ...partialNames.map((name) => join(partials, name)),
  ];
  return Promise.all(
    paths.map(async (path) => ({
      path: relative(fixtureRoot, path),
      content: await readFile(path, "utf8"),
    })),
  );
}
