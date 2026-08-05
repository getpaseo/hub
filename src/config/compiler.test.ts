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

describe("workflow compiler", () => {
  it("compiles the complete multi-step contract and freezes it", () => {
    const compiled = compileHubConfig({
      ...configuration(),
      triggers: [
        {
          ...configuration().triggers[0],
          inputs: { repo: { type: "string", choices: ["paseo", "hub"] } },
          values: { selected: "${{ paseo.inputs.repo ?? steps.classify.outputs.repo }}" },
          steps: [
            {
              ...configuration().triggers[0]!.steps[0],
              id: "classify",
              if: "${{ paseo.inputs.repo == null }}",
              output: {
                schema: { type: "object", properties: { repo: { enum: ["paseo", "hub"] } } },
              },
            },
            {
              ...configuration().triggers[0]!.steps[0],
              id: "work",
              if: "${{ values.selected == 'hub' }}",
              prompt: [{ text: "${{ paseo.prompt }} / ${{ values.selected }}" }],
            },
          ],
        },
      ],
    });
    const trigger = compiled.triggers[0]!;
    assert.equal(trigger.steps.length, 2);
    assert.ok(trigger.values["selected"]);
    const firstStep = trigger.steps[0];
    assert.ok(firstStep?.output);
    const schema = firstStep.output.schema;
    assert.ok(typeof schema === "object" && schema !== null && !Array.isArray(schema));
    assert.equal(schema["type"], "object");
    assert.equal(Object.isFrozen(compiled), true);
    assert.equal(Object.isFrozen(trigger.steps[1]), true);
  });

  it("rejects duplicate IDs, unknown references, forward references, and value cycles", () => {
    const trigger = configuration().triggers[0]!;
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [{ ...trigger, steps: [trigger.steps[0]!, trigger.steps[0]!] }],
        }),
      /duplicate step id/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [{ ...trigger, values: { selected: "${{ steps.missing.outputs.repo }}" } }],
        }),
      /unknown step/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [
                { ...trigger.steps[0]!, if: "${{ steps.later.outputs.repo == 'hub' }}" },
                { ...trigger.steps[0]!, id: "later", output: { schema: { type: "object" } } },
              ],
            },
          ],
        }),
      /forward step/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              values: { first: "${{ values.second }}", second: "${{ values.first }}" },
            },
          ],
        }),
      /cycle/iu,
    );
  });

  it("requires declared output schemas for output paths and validates JSON Schema", () => {
    const trigger = configuration().triggers[0]!;
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [
                { ...trigger.steps[0]!, id: "first" },
                {
                  ...trigger.steps[0]!,
                  id: "second",
                  if: "${{ steps.first.outputs.repo == 'hub' }}",
                },
              ],
            },
          ],
        }),
      /without an output schema/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [{ ...trigger.steps[0]!, output: { schema: { type: "not-a-schema" } } }],
            },
          ],
        }),
      /invalid JSON Schema/iu,
    );
  });

  it("keeps authority finite and rejects prompt authority", () => {
    const trigger = configuration().triggers[0]!;
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              steps: [{ ...trigger.steps[0]!, agent: { provider: "${{ paseo.prompt }}" } }],
            },
          ],
        }),
      /authority/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...trigger,
              inputs: { provider: { type: "string" } },
              steps: [
                { ...trigger.steps[0]!, agent: { provider: "${{ paseo.inputs.provider }}" } },
              ],
            },
          ],
        }),
      /finite choices/iu,
    );
  });

  it("re-establishes the multi-step contract for stored JSON and hashes all compiled fields", () => {
    const compiled = compileHubConfig(configuration());
    assert.deepEqual(parseCompiledHubConfig(compiled), compiled);
    assert.throws(
      () =>
        parseCompiledHubConfig({
          ...compiled,
          triggers: [{ ...compiled.triggers[0]!, steps: [] }],
        }),
      /invalid compiled workflow contract/iu,
    );
    assert.notEqual(rawConfigurationHash(configuration()), compiledConfigurationHash(compiled));
    assert.notEqual(
      compiledConfigurationHash(compiled),
      compiledConfigurationHash(
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...configuration().triggers[0],
              steps: [
                {
                  ...configuration().triggers[0]!.steps[0],
                  output: { schema: { type: "object" } },
                },
              ],
            },
          ],
        }),
      ),
    );
  });

  it("rejects removed trigger syntax and timeout while retaining prompt partial rejection", () => {
    assert.throws(
      () => compileHubConfig({ ...configuration(), timeout: "1m" }),
      /timeout.*max_runtime/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [{ ...configuration().triggers[0], environment: "runner" }],
        }),
      /trigger-level environment/iu,
    );
    assert.throws(
      () =>
        compileHubConfig({
          ...configuration(),
          triggers: [
            {
              ...configuration().triggers[0],
              steps: [
                { ...configuration().triggers[0]!.steps[0], prompt: [{ include: "developer.md" }] },
              ],
            },
          ],
        }),
      /Phase 4/iu,
    );
  });
});
