import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { deriveChecklist, type ChecklistFacts } from "./checklist.js";

const nothing: ChecklistFacts = {
  appsConfigured: true,
  connections: [],
  daemons: [],
  triggers: [],
  latestRun: null,
};

const devbox = {
  id: "2",
  slug: "devbox",
  presence: "connected" as const,
  canExecute: true,
  runs: 0,
};

function keys(facts: ChecklistFacts) {
  return deriveChecklist(facts).steps.map((step) => step.key);
}

function states(facts: ChecklistFacts) {
  return deriveChecklist(facts).steps.map((step) => step.state);
}

describe("the onboarding checklist", () => {
  it("starts with the daemon, because every trigger runs on one and no trigger needs an integration", () => {
    const checklist = deriveChecklist(nothing);
    assert.deepEqual(keys(nothing), ["daemon", "trigger", "run"]);
    assert.deepEqual(states(nothing), ["pending", "pending", "pending"]);
    assert.equal(checklist.completed, 0);
    assert.equal(checklist.complete, false);
  });

  it("keeps the integration beside the steps, so a webhook or schedule user is never blocked on it", () => {
    for (const facts of [
      nothing,
      { ...nothing, appsConfigured: false },
      {
        ...nothing,
        connections: [
          {
            provider: "github" as const,
            slug: "acme",
            label: "acme",
            status: "connected" as const,
          },
        ],
      },
    ]) {
      assert.deepEqual(keys(facts), ["daemon", "trigger", "run"]);
    }
  });

  it("offers an integration until one is connected, and app setup when this Hub has none", () => {
    assert.equal(deriveChecklist(nothing).integration, "pending");
    assert.equal(deriveChecklist({ ...nothing, appsConfigured: false }).integration, "setup");
    const connected = {
      ...nothing,
      connections: [
        { provider: "github" as const, slug: "acme", label: "acme", status: "connected" as const },
      ],
    };
    assert.equal(deriveChecklist(connected).integration, "done");
    assert.equal(deriveChecklist({ ...connected, appsConfigured: false }).integration, "done");
  });

  it("tells a daemon that cannot run agents apart from no daemon at all", () => {
    const laptop = { ...devbox, id: "1", slug: "laptop", canExecute: false };
    const offline = { ...devbox, presence: "offline" as const };
    assert.equal(states({ ...nothing, daemons: [laptop] })[0], "cannotRun");
    assert.equal(states({ ...nothing, daemons: [laptop, offline] })[0], "done");
  });

  it("completes and counts once a daemon, a trigger, and a run exist, with no integration", () => {
    const checklist = deriveChecklist({
      ...nothing,
      daemons: [devbox],
      triggers: [{ id: "t", name: "alert", events: ["webhook.received"], enabled: true }],
      latestRun: { triggerName: "alert", receivedAt: "2026-09-01T12:00:00.000Z" },
    });
    assert.equal(checklist.completed, 3);
    assert.equal(checklist.complete, true);
    assert.equal(checklist.integration, "pending");
  });
});
