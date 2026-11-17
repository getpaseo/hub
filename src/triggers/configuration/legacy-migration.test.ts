import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubBundle } from "../../config/bundle.js";
import { migrateLegacyBundle, parseTriggerDocument } from "./index.js";

const hub = `
environments:
  runner:
    kind: daemon
    daemon: devbox
    cwd: /workspace/company
agents:
  codex:
    provider: codex
    model: gpt-5.6-sol
`;

describe("legacy project bundle migration", () => {
  it.each([undefined, ["maintainer"]])(
    "preserves GitHub team filters with from_users %j in an active single-step revision",
    (fromUsers) => {
      const files = [
        { path: ".paseo/hub.yml", content: hub },
        {
          path: ".paseo/workflows/github.yml",
          content: `
name: github-help
on: github.issue_comment_created
max_runtime: 2h
filters:
  connection: getpaseo-github
  from_teams: [getpaseo/maintainers]
${fromUsers === undefined ? "" : "  from_users: [maintainer]\n"}  contains: "@paseo-bot"
steps:
  - id: work
    environment: runner
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    prompt: [{ text: "Handle the request." }]
`,
        },
      ];
      const before = compileHubBundle(files).configuration;
      const migrated = migrateLegacyBundle({ files, normalizedConfiguration: before });
      assert.equal(migrated.length, 1);
      const result = migrated[0];
      assert.equal(result?.format, "single_run");
      if (result?.format !== "single_run") throw new Error("expected a converted trigger");

      const filters = parseTriggerDocument(result.yaml).on["github.issue_comment_created"]?.filters;
      assert.deepEqual(filters?.from_teams, ["getpaseo/maintainers"]);
      assert.deepEqual(filters?.from_users, fromUsers);
      assert.deepEqual(result.compiled.events[0]?.filters, before.triggers[0]?.filters);
    },
  );

  it("inlines a one-step workflow and its prompt partial into one trigger document", () => {
    const migrated = migrateLegacyBundle({
      files: [
        { path: ".paseo/hub.yml", content: hub },
        {
          path: ".paseo/workflows/slack.yml",
          content: `
name: slack-help
on: slack.mention
max_runtime: 2h
filters:
  connection: acme-slack
  from_users: [U123]
steps:
  - id: work
    environment: runner
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    prompt:
      - include: partials/safety.md
      - text: "Request: \${{ paseo.prompt }}"
    allow_outputs:
      - { type: slack.reply, max: 5 }
`,
        },
        {
          path: ".paseo/workflows/partials/safety.md",
          content: "Never disclose secrets.",
        },
      ],
    });

    assert.equal(migrated.length, 1);
    const trigger = migrated[0];
    assert.equal(trigger?.format, "single_run");
    if (trigger?.format !== "single_run") return;
    assert.match(trigger.yaml, /daemon: devbox/u);
    assert.match(trigger.yaml, /provider: codex/u);
    assert.match(trigger.yaml, /Never disclose secrets\.\n\s+Request:/u);
    assert.doesNotMatch(trigger.yaml, /include:|partials|steps:/u);
  });

  it("preserves a multi-step workflow as one self-contained normalized legacy trigger", () => {
    const migrated = migrateLegacyBundle({
      files: [
        { path: ".paseo/hub.yml", content: hub },
        {
          path: ".paseo/workflows/route.yml",
          content: `
name: route
on: manual.run
max_runtime: 2h
steps:
  - id: classify
    environment: runner
    max_runtime: 2m
    idle_timeout: 30s
    agent: codex
    prompt: [{ text: classify }]
  - id: work
    environment: runner
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    prompt: [{ text: work }]
`,
        },
      ],
    });

    assert.equal(migrated[0]?.format, "legacy_multistep");
    const trigger = migrated[0];
    if (trigger?.format !== "legacy_multistep") return;
    assert.equal(trigger.normalized.trigger.steps.length, 2);
    assert.equal(trigger.normalized.environments.length, 1);
    assert.deepEqual(trigger.conversionBlockers, ["trigger has multiple steps"]);
  });
});
