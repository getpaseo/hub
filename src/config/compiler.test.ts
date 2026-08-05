import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  compileHubConfig,
  compiledConfigurationHash,
  parseCompiledHubConfig,
  rawConfigurationHash,
} from "./compiler.js";

const environment = { name: "runner", kind: "docker" as const, image: "paseo/test" };

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    environments: [environment],
    triggers: [
      {
        name: "run",
        on: "manual.run",
        max_runtime: "1h",
        steps: [
          {
            id: "work",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex", model: "small" },
            prompt: [{ text: "Do the work." }],
            allow_outputs: [{ type: "manual.reply", max: 2 }],
            auto_archive: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("Phase 1 workflow compiler", () => {
  it("compiles one inline text step and preserves the complete contract", () => {
    const compiled = compileHubConfig(configuration());
    const trigger = compiled.triggers[0]!;
    const step = trigger.steps[0];

    assert.equal(trigger.maxRuntimeMs, 3_600_000);
    assert.equal(step.maxRuntimeMs, 600_000);
    assert.equal(step.idleTimeoutMs, 60_000);
    assert.deepEqual(step.prompt, [{ kind: "text", value: "Do the work." }]);
    assert.deepEqual(step.allowOutputs, [{ type: "manual.reply", max: 2 }]);
    assert.equal(step.autoArchive, true);
    assert.equal(Object.isFrozen(compiled), true);
    assert.equal(Object.isFrozen(step), true);
  });

  it.each([
    ["environment", "trigger-level environment"],
    ["agent", "trigger-level agent"],
    ["prompt", "trigger-level prompt"],
    ["idle_timeout", "trigger-level idle_timeout"],
    ["auto_archive", "trigger-level auto_archive"],
    ["allow_outputs", "trigger-level allow_outputs"],
  ])("rejects old trigger-level %s syntax", (field, message) => {
    assert.throws(
      () =>
        compileHubConfig(
          configuration({ triggers: [{ ...configuration().triggers[0], [field]: "old" }] }),
        ),
      new RegExp(message, "u"),
    );
  });

  it.each(["inputs", "values"])("rejects later-phase trigger field %s", (field) => {
    assert.throws(
      () =>
        compileHubConfig(
          configuration({ triggers: [{ ...configuration().triggers[0], [field]: {} }] }),
        ),
      new RegExp(`${field}.*Phase 1`, "u"),
    );
  });

  it.each(["if", "output"])("rejects later-phase step field %s", (field) => {
    const trigger = configuration().triggers[0]!;
    const step = trigger.steps[0]!;
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [{ ...trigger, steps: [{ ...step, [field]: {} }] }],
        }),
      new RegExp(`${field}.*Phase 1`, "u"),
    );
  });

  it("rejects includes, expressions, and multiple steps", () => {
    const trigger = configuration().triggers[0]!;
    const step = trigger.steps[0]!;
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [{ ...trigger, steps: [{ ...step, prompt: [{ include: "developer.md" }] }] }],
        }),
      /prompt.*include.*Phase 1/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            { ...trigger, steps: [{ ...step, agent: { provider: "${{ values.agent }}" } }] },
          ],
        }),
      /expressions.*Phase 1/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({ ...configuration(), triggers: [{ ...trigger, steps: [step, step] }] }),
      /exactly one.*Phase 1/iu,
    );
  });

  it("rejects timeout at every authored nesting level", () => {
    assert.throws(
      () => compileHubConfig({ ...configuration(), timeout: "1m" }),
      /timeout.*max_runtime/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...configuration().triggers[0],
              steps: [{ ...configuration().triggers[0]!.steps[0], timeout: "1m" }],
            },
          ],
        }),
      /timeout.*max_runtime/iu,
    );
  });

  it("rejects duplicate IDs, unknown environments, and unsafe external launches", () => {
    assert.throws(
      () => compileHubConfig({ ...configuration(), environments: [environment, environment] }),
      /duplicate environment/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...configuration().triggers[0],
              steps: [{ ...configuration().triggers[0]!.steps[0], environment: "missing" }],
            },
          ],
        }),
      /unknown environment/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [{ ...configuration().triggers[0], on: "slack.mention" }],
        }),
      /from_users/iu,
    );
  });

  it("re-establishes the single-step contract when parsing stored JSON", () => {
    const compiled = compileHubConfig(configuration());
    assert.deepEqual(parseCompiledHubConfig(compiled), compiled);
    assert.throws(
      () =>
        parseCompiledHubConfig({ ...compiled, triggers: [{ ...compiled.triggers[0], steps: [] }] }),
      /invalid compiled workflow contract/iu,
    );
    assert.throws(
      () =>
        parseCompiledHubConfig({
          ...compiled,
          triggers: [{ ...compiled.triggers[0], filters: { resourceId: "9" } }],
        }),
      /invalid compiled workflow contract/iu,
    );
  });

  it("separates raw and validated compiled hashing", () => {
    const compiled = compileHubConfig(configuration());
    assert.notEqual(rawConfigurationHash(configuration()), compiledConfigurationHash(compiled));
    assert.notEqual(
      compiledConfigurationHash(compiled),
      compiledConfigurationHash(
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...configuration().triggers[0],
              steps: [{ ...configuration().triggers[0]!.steps[0], prompt: [{ text: "changed" }] }],
            },
          ],
        }),
      ),
    );
  });
});
