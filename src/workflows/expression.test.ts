import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  parseExpression,
  renderExecutionTemplate,
  renderExpressionTemplate,
} from "./expression.js";

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

  it("renders the stable execution ID without provider context", () => {
    assert.equal(
      renderExecutionTemplate(
        "trigger-${{ paseo.execution.id }}",
        "64ae56ff-281c-4c5f-bf5c-d572f125c702",
      ),
      "trigger-64ae56ff-281c-4c5f-bf5c-d572f125c702",
    );
  });

  it("renders the provider-authenticated conversation key only when supplied", () => {
    const context = {
      prompt: "the triggering body",
      context: {},
      inputs: {},
      steps: {},
      values: {},
      triggerConversationKey: "slack:thread:1700000000.000001",
    };

    assert.equal(
      renderExpressionTemplate("thread-${{ paseo.trigger.conversation_key }}", context),
      "thread-slack:thread:1700000000.000001",
    );
    assert.deepEqual(parseExpression("${{ paseo.trigger.conversation_key }}"), {
      kind: "path",
      value: { namespace: "paseo", path: ["trigger", "conversation_key"] },
    });
    assert.throws(
      () =>
        renderExpressionTemplate("${{ paseo.trigger.conversation_key }}", {
          prompt: context.prompt,
          context: context.context,
          inputs: context.inputs,
          steps: context.steps,
          values: context.values,
        }),
      /trigger conversation key is unavailable/iu,
    );
  });
});
