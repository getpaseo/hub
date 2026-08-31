import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import {
  deliveryByName,
  loadForgejoContractFixtures,
} from "../../providers/forgejo/fake-server.js";
import { isRecord } from "../../providers/forgejo/contract-test-read.js";
import { classifyForgejoPayload, type NormalizedForgejoEvent } from "./normalize.js";
import { matchForgejoTriggers } from "./matching.js";

const CONNECTION = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme-forgejo",
  instanceId: "inst-1",
};

describe("Forgejo trigger matching", () => {
  it("matches semantic issue_created and rejects a different family", async () => {
    const opened = await eventNamed("issues-opened");
    const comment = await eventNamed("issue-comment-created");
    const config = configFor("forgejo.issue_created");
    assert.equal(matchForgejoTriggers(config, opened, CONNECTION.id).length, 1);
    assert.equal(matchForgejoTriggers(config, comment, CONNECTION.id).length, 0);
  });

  it("matches actor, connection, repository, substring, and current labels with AND", async () => {
    const opened = await eventNamed("issues-opened");
    const config = compileHubConfig({
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "forgejo-issue",
          on: "forgejo.issue_created",
          max_runtime: "2h",
          filters: {
            from_users: ["t00bot"],
            repo: "t00org/t00repo",
            contains: "Issue body",
            connection: "acme-forgejo",
          },
          steps: [step()],
        },
      ],
    });
    const trigger = config.triggers[0]!;
    const configured = {
      ...config,
      triggers: [{ ...trigger, filters: { ...trigger.filters, connectionId: CONNECTION.id } }],
    };
    assert.equal(matchForgejoTriggers(configured, opened, CONNECTION.id).length, 1);
    assert.equal(matchForgejoTriggers(configured, opened, "other").length, 0);
  });

  it("fans out zero, one, or many routes with stable event and route identities", async () => {
    const opened = await eventNamed("issues-opened");
    const many = compileHubConfig({
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "one",
          on: "forgejo.issue_created",
          max_runtime: "2h",
          filters: { from_users: ["*"] },
          steps: [step()],
        },
        {
          name: "two",
          on: "forgejo.issues",
          max_runtime: "2h",
          filters: { from_users: ["*"] },
          steps: [step()],
        },
      ],
    });
    const matches = matchForgejoTriggers(many, opened, CONNECTION.id);
    assert.equal(matches.length, 2);
    assert.equal(new Set(matches.map((match) => match.routeRunIdentity)).size, 2);
    assert.equal(matches[0]?.event.identity.eventId, matches[1]?.event.identity.eventId);
    assert.equal(matchForgejoTriggers(configFor("forgejo.push"), opened, CONNECTION.id).length, 0);
  });

  it("does not match incomplete label deliveries as issue_label_added", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "issue-label-updated");
    const result = classifyForgejoPayload({
      deliveryId: String(delivery.headers["x-forgejo-delivery"]),
      event: delivery.event,
      eventType: delivery.eventType,
      payload: asRecord(delivery.payload),
      connection: CONNECTION,
    });
    assert.equal(result.kind, "signal");
  });
});

async function eventNamed(name: string): Promise<NormalizedForgejoEvent> {
  const fixtures = await loadForgejoContractFixtures();
  const delivery = deliveryByName(fixtures, name);
  const result = classifyForgejoPayload({
    deliveryId: String(delivery.headers["x-forgejo-delivery"]),
    event: delivery.event,
    eventType: delivery.eventType,
    payload: asRecord(delivery.payload),
    connection: CONNECTION,
  });
  if (result.kind !== "event") throw new Error(`${name} is not a complete event`);
  return result.event;
}

function configFor(on: string) {
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "forgejo-route",
        on,
        max_runtime: "2h",
        filters: { from_users: ["*"] },
        steps: [step()],
      },
    ],
  });
}

function step() {
  return {
    id: "reply",
    environment: "runner",
    max_runtime: "1h",
    idle_timeout: "5m",
    agent: { provider: "opencode", mode: "default" },
    prompt: [{ text: "Handle it" }],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(isRecord(value), true);
  if (!isRecord(value)) throw new Error("expected object");
  return value;
}
