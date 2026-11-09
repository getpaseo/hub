import assert from "node:assert/strict";
import { it } from "vitest";
import { connectionStatusSchema } from "./functions.js";

it("keeps provider readiness separate from connection inventory", () => {
  const status = connectionStatusSchema.parse({
    canManage: true,
    github: { status: "connected" },
    discord: { status: "connected" },
    slack: { status: "disconnected" },
    linear: { status: "disconnected" },
  });
  assert.deepEqual(status, {
    canManage: true,
    github: { status: "connected" },
    discord: { status: "connected" },
    slack: { status: "disconnected" },
    linear: { status: "disconnected" },
  });
});

it("rejects readiness states outside each registered provider's contract", () => {
  const connected = {
    canManage: true,
    github: { status: "connected" },
    discord: { status: "connected" },
    slack: { status: "connected" },
    linear: { status: "connected" },
  };
  for (const [provider, status] of [
    ["github", "requiresReauthorization"],
    ["discord", "suspended"],
    ["slack", "suspended"],
    ["linear", "suspended"],
  ] as const) {
    assert.equal(
      connectionStatusSchema.safeParse({ ...connected, [provider]: { status } }).success,
      false,
    );
  }
});
