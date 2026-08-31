import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { linearConnectionActionLabels } from "./linear-actions.js";

describe("Linear connection actions", () => {
  it("makes Agent Session scope downgrades explicit during reauthorization", () => {
    assert.deepEqual(linearConnectionActionLabels(true), {
      baseline: "Reauthorize Linear without Agent Sessions",
      agentSessions: "Reauthorize Linear for Agent Sessions",
    });
  });

  it("keeps initial connection choices explicit", () => {
    assert.deepEqual(linearConnectionActionLabels(false), {
      baseline: "Connect Linear",
      agentSessions: "Connect Linear for Agent Sessions",
    });
  });
});
