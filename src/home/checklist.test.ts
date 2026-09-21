import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { deriveChecklist, type ChecklistFacts } from "./checklist.js";

const nothing: ChecklistFacts["snapshot"] = {
  connections: [],
  daemons: [],
  triggers: [],
  runs: [],
};

function states(facts: ChecklistFacts) {
  return deriveChecklist(facts).steps.map((step) => step.state);
}

describe("the onboarding checklist", () => {
  it("starts with every step pending on a hosted Hub whose apps exist", () => {
    const checklist = deriveChecklist({ appsConfigured: true, snapshot: nothing });
    assert.deepEqual(
      checklist.steps.map((step) => step.state),
      ["pending", "pending", "pending", "pending"],
    );
    assert.equal(checklist.completed, 0);
    assert.equal(checklist.complete, false);
  });

  it("sends a self-hosted operator to app setup when no provider app is configured", () => {
    assert.equal(states({ appsConfigured: false, snapshot: nothing })[0], "setup");
  });

  it("marks the app step done by a connection, whatever the app situation", () => {
    const snapshot = {
      ...nothing,
      connections: [{ provider: "github" as const, slug: "acme", label: "acme" }],
    };
    assert.equal(states({ appsConfigured: true, snapshot })[0], "done");
    assert.equal(states({ appsConfigured: false, snapshot })[0], "done");
  });

  it("tells a daemon that cannot run agents apart from no daemon at all", () => {
    const laptop = { id: "1", slug: "laptop", presence: "connected" as const, canExecute: false };
    const devbox = { id: "2", slug: "devbox", presence: "offline" as const, canExecute: true };
    assert.equal(
      states({ appsConfigured: true, snapshot: { ...nothing, daemons: [laptop] } })[1],
      "cannotRun",
    );
    assert.equal(
      states({ appsConfigured: true, snapshot: { ...nothing, daemons: [laptop, devbox] } })[1],
      "done",
    );
  });

  it("completes and counts once a trigger exists and has run", () => {
    const checklist = deriveChecklist({
      appsConfigured: true,
      snapshot: {
        connections: [{ provider: "slack", slug: "acme", label: "Acme" }],
        daemons: [{ id: "2", slug: "devbox", presence: "connected", canExecute: true }],
        triggers: [{ id: "t", name: "slack-help", event: "slack.mention", enabled: true }],
        runs: [
          {
            id: "r",
            triggerName: "slack-help",
            provider: "slack",
            source: "slack.mention",
            status: "succeeded",
            receivedAt: "2026-09-21T12:00:00.000Z",
            agent: { provider: "codex", model: "gpt-5.4" },
          },
        ],
      },
    });
    assert.equal(checklist.completed, 4);
    assert.equal(checklist.complete, true);
  });
});
