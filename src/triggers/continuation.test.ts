import assert from "node:assert/strict";
import { test } from "vitest";
import { continuationKey } from "./continuation.js";

test("conversation policy uses opaque identity and events without a conversation get a new agent", () => {
  const render = () => {
    throw new Error("No expression expected");
  };
  assert.equal(
    continuationKey({ mode: "conversation" }, { key: "opaque", label: "Thread" }, render),
    "opaque",
  );
  assert.equal(continuationKey({ mode: "conversation" }, null, render), null);
  assert.equal(continuationKey({ mode: "new" }, { key: "opaque", label: "Thread" }, render), null);
});

test("custom keys render through the existing expression evaluator and reject empty or non-string results", () => {
  const policy = { mode: "key", key: "${{ paseo.inputs.ticket }}" } as const;
  assert.equal(
    continuationKey(policy, null, (template) => {
      assert.equal(template, policy.key);
      return "ticket-42";
    }),
    "custom:ticket-42",
  );
  for (const result of [undefined, null, 42, "  ", "x".repeat(513)]) {
    assert.throws(() => continuationKey(policy, null, () => result), /non-empty string/);
  }
});
