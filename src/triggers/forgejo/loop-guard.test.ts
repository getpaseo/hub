import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isForgejoOwnAccountEvent } from "./loop-guard.js";

describe("isForgejoOwnAccountEvent", () => {
  it("matches on sender.id for an ordinary delivery", () => {
    const event = { payload: { sender: { id: 42, login: "trillian" } } };
    assert.equal(isForgejoOwnAccountEvent(event, [42]), true);
    assert.equal(isForgejoOwnAccountEvent(event, [7]), false);
  });

  it("falls back to run.trigger_user.id when there is no sender", () => {
    const event = { payload: { action: "failure", run: { trigger_user: { id: 42 } } } };
    assert.equal(isForgejoOwnAccountEvent(event, [42]), true);
    assert.equal(isForgejoOwnAccountEvent(event, [7]), false);
  });

  it("does not match when neither sender nor run.trigger_user is present", () => {
    assert.equal(isForgejoOwnAccountEvent({ payload: {} }, [42]), false);
  });

  it("prefers sender.id over run.trigger_user.id when both happen to be present", () => {
    const event = {
      payload: { sender: { id: 7 }, run: { trigger_user: { id: 42 } } },
    };
    assert.equal(isForgejoOwnAccountEvent(event, [7]), true);
    assert.equal(isForgejoOwnAccountEvent(event, [42]), false);
  });
});
