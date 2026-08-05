import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  compileHubConfig,
  compiledConfigurationHash,
  parseExpression,
  type AuthoredHubConfig,
} from "./compiler.js";

describe("Hub configuration compiler", () => {
  it("compiles the canonical step-based workflow contract", () => {
    const compiled = compileHubConfig(canonicalConfiguration);

    assert.equal(compiled.triggers[0]?.name, "chat-request");
    assert.equal(compiled.triggers[0]?.maxRuntimeMs, 2 * 60 * 60_000);
    assert.deepEqual(compiled.triggers[0]?.inputs.repo, {
      type: "string",
      required: false,
      choices: ["paseo", "hub"],
    });
    assert.equal(compiled.triggers[0]?.steps[0]?.maxRuntimeMs, 2 * 60_000);
    assert.equal(compiled.triggers[0]?.steps[0]?.idleTimeoutMs, 30_000);
    assert.deepEqual(compiled.triggers[0]?.steps[0]?.prompt[0], {
      kind: "include",
      path: "classify.md",
    });
    assert.equal(compiled.triggers[0]?.steps[0]?.prompt[1]?.kind, "text");
    assert.equal(compiled.triggers[0]?.steps[0]?.if?.kind, "binary");
    assert.equal(compiled.triggers[0]?.values.repo?.kind, "binary");
    assert.notEqual(Object.isFrozen(compiled), false);
  });

  it("parses JSON literals and the supported operator grammar without evaluation", () => {
    assert.deepEqual(parseExpression('${{ {"repo":"hub"} }}'), {
      kind: "literal",
      value: { repo: "hub" },
    });
    assert.equal(parseExpression("${{ ! (true == false) }}").kind, "unary");
  });

  it.each([
    "environment",
    "agent",
    "prompt",
    "timeout",
    "idle_timeout",
    "auto_archive",
    "allow_outputs",
  ])("rejects removed trigger-level %s with a migration hint", (field) => {
    const configuration = structuredClone(canonicalConfiguration) as Record<string, unknown>;
    const trigger = (configuration.triggers as Array<Record<string, unknown>>)[0]!;
    trigger[field] = field === "agent" ? { provider: "codex" } : "removed";

    assert.throws(() => compileHubConfig(configuration), new RegExp(`${field}.*step`, "iu"));
  });

  it("rejects timeout and points authors at max_runtime", () => {
    const configuration = structuredClone(canonicalConfiguration) as Record<string, unknown>;
    const trigger = (configuration.triggers as Array<Record<string, unknown>>)[0]!;
    trigger.timeout = "1h";

    assert.throws(() => compileHubConfig(configuration), /timeout.*max_runtime/iu);
  });

  it.each([
    [
      "duplicate step IDs",
      (config: Record<string, unknown>) => {
        const trigger = (config.triggers as Array<Record<string, unknown>>)[0]!;
        const steps = trigger.steps as Array<Record<string, unknown>>;
        steps[1] = { ...steps[1], id: steps[0]!.id };
      },
    ],
    [
      "unknown step references",
      (config: Record<string, unknown>) => {
        const trigger = (config.triggers as Array<Record<string, unknown>>)[0]!;
        const values = trigger.values as Record<string, string>;
        values.repo = "${{ steps.missing.outputs.repo }}";
      },
    ],
    [
      "forward step references",
      (config: Record<string, unknown>) => {
        const trigger = (config.triggers as Array<Record<string, unknown>>)[0]!;
        const steps = trigger.steps as Array<Record<string, unknown>>;
        steps[0]!.if = "${{ steps.work-on-hub.outputs.repo == 'hub' }}";
        steps[1]!.output = { schema: { type: "object", properties: { repo: { type: "string" } } } };
      },
    ],
    [
      "value cycles",
      (config: Record<string, unknown>) => {
        const trigger = (config.triggers as Array<Record<string, unknown>>)[0]!;
        trigger.values = { first: "${{ values.second }}", second: "${{ values.first }}" };
      },
    ],
    [
      "invalid choices",
      (config: Record<string, unknown>) => {
        const trigger = (config.triggers as Array<Record<string, unknown>>)[0]!;
        const inputs = trigger.inputs as Record<string, Record<string, unknown>>;
        inputs.agent.choices = ["codex", 3];
      },
    ],
    [
      "unsafe prompt includes",
      (config: Record<string, unknown>) => {
        const trigger = (config.triggers as Array<Record<string, unknown>>)[0]!;
        const steps = trigger.steps as Array<Record<string, unknown>>;
        steps[0]!.prompt = [{ include: "../secret.md" }];
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const configuration = structuredClone(canonicalConfiguration) as Record<string, unknown>;
    mutate(configuration);
    assert.throws(() => compileHubConfig(configuration));
  });

  it("changes the compiled contract hash when a step changes", () => {
    const first = compileHubConfig(canonicalConfiguration);
    const changed = structuredClone(canonicalConfiguration) as AuthoredHubConfig;
    changed.triggers[0]!.steps[0]!.max_runtime = "3m";
    const second = compileHubConfig(changed);

    assert.notEqual(compiledConfigurationHash(first), compiledConfigurationHash(second));
  });

  it("does not retain the legacy trigger execution parser or default hydrator", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const schemaSource = readFileSync(join(here, "schema.ts"), "utf8");
    const storeSource = readFileSync(join(here, "../configuration/store.ts"), "utf8");

    assert.equal(schemaSource.includes("TriggerSchema"), false);
    assert.equal(schemaSource.includes("parseTriggerTimeoutMs"), false);
    assert.equal(storeSource.includes("hydrateTriggerDefaults"), false);
    assert.equal(storeSource.includes("restoreAuthoredTemplates"), false);
  });

  it.each([
    [
      "invalid IDs",
      (config: Record<string, unknown>) => {
        const trigger = (config.triggers as Array<Record<string, unknown>>)[0]!;
        trigger.name = "Not an ID";
      },
    ],
    [
      "invalid expressions",
      (config: Record<string, unknown>) => {
        const trigger = (config.triggers as Array<Record<string, unknown>>)[0]!;
        trigger.values = { repo: "${{ paseo.inputs.repo + 'hub' }}" };
      },
    ],
    [
      "invalid JSON schemas",
      (config: Record<string, unknown>) => {
        const trigger = (config.triggers as Array<Record<string, unknown>>)[0]!;
        const steps = trigger.steps as Array<Record<string, unknown>>;
        steps[0]!.output = { schema: { type: "object", required: ["missing"], properties: {} } };
      },
    ],
    [
      "invalid durations",
      (config: Record<string, unknown>) => {
        const trigger = (config.triggers as Array<Record<string, unknown>>)[0]!;
        trigger.max_runtime = "0s";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const configuration = structuredClone(canonicalConfiguration) as Record<string, unknown>;
    mutate(configuration);
    assert.throws(() => compileHubConfig(configuration));
  });
});

const canonicalConfiguration = {
  environments: [
    { name: "classifier", kind: "docker", image: "paseo/classifier" },
    { name: "hub-devbox", kind: "daemon", daemon: "hub-devbox", cwd: "/workspace" },
  ],
  triggers: [
    {
      name: "chat-request",
      on: "slack.mention",
      max_runtime: "2h",
      inputs: {
        repo: { type: "string", required: false, choices: ["paseo", "hub"] },
        agent: { type: "string", default: "codex", choices: ["codex", "opus"] },
      },
      values: {
        repo: "${{ paseo.inputs.repo ?? steps.classify.outputs.repo }}",
      },
      steps: [
        {
          id: "classify",
          if: "${{ paseo.inputs.repo == null }}",
          environment: "classifier",
          max_runtime: "2m",
          idle_timeout: "30s",
          agent: { provider: "codex", model: "small-fast-model", mode: "read-only" },
          prompt: [{ include: "classify.md" }, { text: "Request: ${{ paseo.prompt }}" }],
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["repo"],
              properties: { repo: { enum: ["paseo", "hub"] } },
            },
          },
        },
        {
          id: "work-on-hub",
          if: "${{ values.repo == 'hub' }}",
          environment: "hub-devbox",
          max_runtime: "90m",
          idle_timeout: "10m",
          auto_archive: true,
          agent: { provider: "${{ paseo.inputs.agent }}" },
          prompt: [
            { include: "developer.md" },
            { include: "chat-progress.md" },
            { text: "User request: ${{ paseo.prompt }}" },
          ],
          allow_outputs: [{ type: "slack.reply", max: 5 }],
        },
      ],
    },
  ],
} satisfies AuthoredHubConfig;
