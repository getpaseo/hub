import { expect, it } from "vitest";
import { compileTriggerDocument } from "../configuration/index.js";

import { webhookYaml } from "./test-fixture.js";

it("compiles a webhook without a connection or actor and appends the delivery prompt", () => {
  const { events } = compileTriggerDocument(webhookYaml);
  expect(events).toMatchObject([{ name: "alert-handler", on: "webhook.received" }]);
  expect(JSON.stringify(events[0]?.steps[0]?.prompt)).toContain("paseo.prompt");
});

it("renders the delivery where the instructions reference it", () => {
  const instructions = "Read the delivery: ${{paseo.prompt}}";
  const { events } = compileTriggerDocument(
    webhookYaml.replace("Summarize the alert.", JSON.stringify(instructions)),
  );
  expect(events[0]?.steps[0]?.prompt).toEqual([{ kind: "text", value: instructions }]);
});

it("refuses webhook connection filters instead of silently ignoring them", () => {
  expect(() =>
    compileTriggerDocument(webhookYaml.replace("{}", "{filters: {from_users: ['*']}}")),
  ).toThrow(/Webhook/);
});
