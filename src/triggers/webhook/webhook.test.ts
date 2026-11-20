import { expect, it } from "vitest";
import { renderExpressionTemplate } from "../../workflows/expression.js";
import { compileTriggerDocument } from "../configuration/index.js";

import { webhookYaml } from "./test-fixture.js";

it("compiles a webhook without a connection or actor and appends the delivery prompt", () => {
  const { events } = compileTriggerDocument(webhookYaml);
  expect(events).toMatchObject([{ name: "alert-handler", on: "webhook.received" }]);
  expect(JSON.stringify(events[0]?.steps[0]?.prompt)).toContain("paseo.prompt");
});

it.each([
  ["Read the delivery: ${{paseo.prompt}}", "Read the delivery: webhook payload"],
  ["Read the delivery: ${{ (paseo.prompt) }}", "Read the delivery: webhook payload"],
  ["Delivery received: ${{ paseo.prompt != '' }}", "Delivery received: true\nwebhook payload"],
])("renders the delivery once with instructions %s", (instructions, expected) => {
  const { events } = compileTriggerDocument(
    webhookYaml.replace("Summarize the alert.", JSON.stringify(instructions)),
  );
  const prompt = events[0]?.steps[0]?.prompt
    .map((block) =>
      renderExpressionTemplate(block.kind === "text" ? block.value : block.content, {
        prompt: "webhook payload",
        context: null,
        inputs: {},
        steps: {},
        values: {},
      }),
    )
    .join("\n");
  expect(prompt).toBe(expected);
});

it("refuses webhook connection filters instead of silently ignoring them", () => {
  expect(() =>
    compileTriggerDocument(webhookYaml.replace("{}", "{filters: {from_users: ['*']}}")),
  ).toThrow(/Webhook/);
});
