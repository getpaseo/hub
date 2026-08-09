import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseExpression, renderExpressionTemplate } from "./expression.js";

describe("workflow expression context", () => {
  it("keeps the triggering prompt and ambient context as distinct merge values", () => {
    const context = {
      prompt: "the triggering body",
      context: { slack: { thread: { messages: [{ content: "earlier" }] } } },
      inputs: {},
      steps: {},
      values: {},
    };

    assert.equal(renderExpressionTemplate("${{ paseo.prompt }}", context), "the triggering body");
    assert.equal(
      renderExpressionTemplate("${{ paseo.context }}", context),
      JSON.stringify(context.context),
    );
    assert.deepEqual(parseExpression("${{ paseo.context }}"), {
      kind: "path",
      value: { namespace: "paseo", path: "context" },
    });
  });
});
