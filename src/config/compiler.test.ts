import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  compileHubConfig,
  compiledConfigurationHash,
  parseCompiledHubConfig,
  parseExpression,
  type AuthoredHubConfig,
} from "./compiler.js";
import * as configExports from "./index.js";

describe("Hub configuration compiler", () => {
  it("compiles the canonical step-based workflow contract", () => {
    const compiled = compileHubConfig(canonicalConfiguration);

    assert.equal(compiled.triggers[0]?.name, "chat-request");
    assert.equal(compiled.triggers[0]?.maxRuntimeMs, 2 * 60 * 60_000);
    assert.deepEqual(compiled.triggers[0]?.inputs["repo"], {
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
    assert.equal(compiled.triggers[0]?.values["repo"]?.kind, "binary");
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
    const configuration = cloneCanonicalConfiguration();
    const trigger = configuration["triggers"][0]!;
    Object.assign(trigger, { [field]: field === "agent" ? { provider: "codex" } : "removed" });

    assert.throws(() => compileHubConfig(configuration), new RegExp(`${field}.*step`, "iu"));
  });

  it("rejects timeout and points authors at max_runtime", () => {
    const configuration = cloneCanonicalConfiguration();
    Object.assign(configuration["triggers"][0]!, { timeout: "1h" });

    assert.throws(() => compileHubConfig(configuration), /timeout.*max_runtime/iu);
  });

  it.each([
    [
      "duplicate step IDs",
      (config: AuthoredHubConfig) => {
        const trigger = config["triggers"][0]!;
        const steps = trigger["steps"];
        steps[1] = { ...steps[1]!, id: steps[0]!.id };
      },
    ],
    [
      "unknown step references",
      (config: AuthoredHubConfig) => {
        const trigger = config["triggers"][0]!;
        trigger["values"] = { ...trigger["values"], repo: "${{ steps.missing.outputs.repo }}" };
      },
    ],
    [
      "forward step references",
      (config: AuthoredHubConfig) => {
        const steps = config["triggers"][0]!["steps"];
        steps[0]!["if"] = "${{ steps.work-on-hub.outputs.repo == 'hub' }}";
        steps[1]!["output"] = {
          schema: { type: "object", properties: { repo: { type: "string" } } },
        };
      },
    ],
    [
      "value cycles",
      (config: AuthoredHubConfig) => {
        config["triggers"][0]!["values"] = {
          first: "${{ values.second }}",
          second: "${{ values.first }}",
        };
      },
    ],
    [
      "invalid choices",
      (config: AuthoredHubConfig) => {
        const input = config["triggers"][0]!["inputs"]?.["agent"];
        if (input === undefined) throw new Error("canonical agent input is missing");
        Object.assign(input, { choices: ["codex", 3] });
      },
    ],
    [
      "unsafe prompt includes",
      (config: AuthoredHubConfig) => {
        config["triggers"][0]!["steps"][0]!["prompt"] = [{ include: "../secret.md" }];
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const configuration = cloneCanonicalConfiguration();
    mutate(configuration);
    assert.throws(() => compileHubConfig(configuration));
  });

  it("changes the compiled contract hash when a step changes", () => {
    const first = compileHubConfig(canonicalConfiguration);
    const changed = cloneCanonicalConfiguration();
    changed["triggers"][0]!["steps"][0]!["max_runtime"] = "3m";
    const second = compileHubConfig(changed);

    assert.notEqual(compiledConfigurationHash(first), compiledConfigurationHash(second));
  });

  it("does not expose the removed trigger execution parser through the config module", () => {
    assert.equal("parseTriggerTimeoutMs" in configExports, false);
    assert.equal("TriggerSchema" in configExports, false);
  });

  it("strictly validates stored compiled contracts", () => {
    const compiled = compileHubConfig(canonicalConfiguration);
    const malformed = structuredClone(compiled);
    Object.assign(malformed["triggers"][0]!, { maxRuntimeMs: "2h" });

    assert.throws(() => parseCompiledHubConfig(malformed), /invalid compiled workflow contract/iu);
  });

  it("rejects unsupported JSON Schema keywords at the compiler boundary", () => {
    const configuration = cloneCanonicalConfiguration();
    configuration["triggers"][0]!["steps"][0]!["output"] = {
      schema: { type: "object", unsupportedKeyword: true },
    };

    assert.throws(() => compileHubConfig(configuration), /invalid JSON Schema/iu);
  });

  it.each(["if", "prompt", "agent"])(
    "rejects transitive forward outputs at the step %s use site",
    (useSite) => {
      const configuration = cloneCanonicalConfiguration();
      const trigger = configuration["triggers"][0]!;
      trigger["values"] = {
        ...trigger["values"],
        later: "${{ steps.work-on-hub.outputs.repo }}",
      };
      trigger["steps"][1]!["output"] = {
        schema: { type: "object", properties: { repo: { type: "string" } } },
      };
      if (useSite === "if") trigger["steps"][0]!["if"] = "${{ values.later == 'hub' }}";
      if (useSite === "prompt") trigger["steps"][0]!["prompt"] = [{ text: "${{ values.later }}" }];
      if (useSite === "agent") trigger["steps"][0]!["agent"]["provider"] = "${{ values.later }}";

      assert.throws(() => compileHubConfig(configuration), /forward step reference/iu);
    },
  );

  it.each([
    [
      "invalid IDs",
      (config: AuthoredHubConfig) => {
        Object.assign(config["triggers"][0]!, { name: "Not an ID" });
      },
    ],
    [
      "invalid expressions",
      (config: AuthoredHubConfig) => {
        config["triggers"][0]!["values"] = { repo: "${{ paseo.inputs.repo + 'hub' }}" };
      },
    ],
    [
      "invalid JSON schemas",
      (config: AuthoredHubConfig) => {
        config["triggers"][0]!["steps"][0]!["output"] = {
          schema: { type: "not-a-json-schema-type" },
        };
      },
    ],
    [
      "invalid durations",
      (config: AuthoredHubConfig) => {
        config["triggers"][0]!["max_runtime"] = "0s";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const configuration = cloneCanonicalConfiguration();
    mutate(configuration);
    assert.throws(() => compileHubConfig(configuration));
  });
});

function cloneCanonicalConfiguration(): AuthoredHubConfig {
  return structuredClone(canonicalConfiguration);
}

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
