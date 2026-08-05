import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { interpolateInvocation, parseInvocation } from "./invocation.js";

const inputs = {
  repo: { type: "string" as const, choices: ["paseo", "hub"] },
  agent: { type: "string" as const, default: "codex", choices: ["codex", "opus"] },
  count: { type: "number" as const },
};

const requiredInputs = {
  ...inputs,
  dry: { type: "boolean" as const, required: true },
};

describe("provider-neutral message invocation parser", () => {
  it.each([
    {
      name: "removes the mention boundary and leading whitespace",
      message: "  @Paseo   repo=hub investigate",
      mention: "@Paseo",
      expected: {
        rawMessage: "  @Paseo   repo=hub investigate",
        prompt: "investigate",
        inputs: { repo: "hub", agent: "codex" },
      },
    },
    {
      name: "accepts zero inputs",
      message: "investigate the failed sync",
      expected: {
        rawMessage: "investigate the failed sync",
        prompt: "investigate the failed sync",
        inputs: { agent: "codex" },
      },
    },
    {
      name: "accepts multiple consecutive inputs",
      message: "repo=hub agent=opus investigate",
      expected: {
        rawMessage: "repo=hub agent=opus investigate",
        prompt: "investigate",
        inputs: { repo: "hub", agent: "opus" },
      },
    },
    {
      name: "preserves whitespace in the prompt remainder",
      message: "repo=hub   investigate   the sync  ",
      expected: {
        rawMessage: "repo=hub   investigate   the sync  ",
        prompt: "investigate   the sync  ",
        inputs: { repo: "hub", agent: "codex" },
      },
    },
    {
      name: "stops at an undeclared key and preserves the entire remainder",
      message: "unknown=value repo=hub investigate",
      expected: {
        rawMessage: "unknown=value repo=hub investigate",
        prompt: "unknown=value repo=hub investigate",
        inputs: { agent: "codex" },
      },
    },
  ])("$name", ({ message, mention, expected }) => {
    assert.deepEqual(parseInvocation(message, inputs, mention), {
      status: "accepted",
      ...expected,
    });
  });

  it.each([
    ["required", "repo=hub investigate", /required input.*dry/iu],
    ["invalid choice", "repo=other investigate", /repo.*choice/iu],
    ["invalid number", "count=not-a-number investigate", /count.*number/iu],
    ["invalid boolean", "dry=sometimes investigate", /dry.*boolean/iu],
    ["duplicate key", "repo=hub repo=paseo investigate", /duplicate.*repo/iu],
  ] as const)("rejects %s values before execution", (_name, message, error) => {
    const result = parseInvocation(
      message,
      _name === "required" || _name === "invalid boolean" ? requiredInputs : inputs,
    );
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.match(result.reason, error);
  });

  it("does not implement a delimiter grammar", () => {
    assert.deepEqual(parseInvocation("-- repo=hub investigate", inputs), {
      status: "accepted",
      rawMessage: "-- repo=hub investigate",
      prompt: "-- repo=hub investigate",
      inputs: { agent: "codex" },
    });
  });

  it("interpolates only the provider-neutral prompt and input paths", () => {
    const invocation = parseInvocation("repo=hub investigate", inputs);
    assert.equal(invocation.status, "accepted");
    if (invocation.status === "accepted") {
      assert.equal(
        interpolateInvocation(
          "Request: ${{ paseo.prompt }} (${{ paseo.inputs.repo }})",
          invocation,
        ),
        "Request: investigate (hub)",
      );
    }
  });
});
