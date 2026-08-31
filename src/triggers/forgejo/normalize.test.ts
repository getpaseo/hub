import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  deliveryByName,
  FORGEJO_EVENT_TABLE,
  loadForgejoContractFixtures,
} from "../../providers/forgejo/fake-server.js";
import { isRecord } from "../../providers/forgejo/contract-test-read.js";
import { classifyForgejoPayload, type ForgejoConnectionContext } from "./normalize.js";

const CONNECTION: ForgejoConnectionContext = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "acme-forgejo",
  instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

describe("Forgejo normalizer", () => {
  it("classifies every T00 fixture into one raw family, semantic, or reconciliation signal", async () => {
    const fixtures = await loadForgejoContractFixtures();
    assert.equal(fixtures.deliveries.length, FORGEJO_EVENT_TABLE.length);
    for (const row of FORGEJO_EVENT_TABLE) {
      const delivery = deliveryByName(fixtures, row.name);
      const result = classifyForgejoPayload({
        deliveryId: String(delivery.headers["x-forgejo-delivery"]),
        event: delivery.event,
        eventType: delivery.eventType,
        payload: recordOf(delivery.payload),
        connection: CONNECTION,
      });
      if (row.signal !== null) {
        assert.equal(result.kind, "signal", row.name);
        if (result.kind !== "signal") continue;
        assert.equal(result.signal.type, row.signal, row.name);
        assert.equal(result.signal.rawFamily, row.rawFamily, row.name);
        assert.equal(result.signal.expectedSemantic ?? null, row.semantic, row.name);
        assert.equal(result.signal.context.actor.login.length > 0, true, row.name);
        continue;
      }
      assert.equal(result.kind, "event", row.name);
      if (result.kind !== "event") continue;
      assert.equal(result.event.rawFamily, row.rawFamily, row.name);
      assert.equal(result.event.semanticEvent ?? null, row.semantic, row.name);
      assert.equal(result.event.context.actor.login.length > 0, true, row.name);
      assert.equal(result.event.context.repository.full_name, "t00org/t00repo", row.name);
      assert.notEqual(result.event.identity.eventId, result.event.context.deliveryId, row.name);
    }
  });

  it("never promotes incomplete label or review webhooks into semantic events", async () => {
    const fixtures = await loadForgejoContractFixtures();
    for (const name of [
      "issue-label-updated",
      "pull-request-label-updated",
      "pull-request-review-submitted",
    ]) {
      const delivery = deliveryByName(fixtures, name);
      const result = classifyForgejoPayload({
        deliveryId: String(delivery.headers["x-forgejo-delivery"]),
        event: delivery.event,
        eventType: delivery.eventType,
        payload: recordOf(delivery.payload),
        connection: CONNECTION,
      });
      assert.equal(result.kind, "signal", name);
      if (result.kind !== "signal") continue;
      assert.equal(
        result.signal.expectedSemantic === "forgejo.issue_label_added" ||
          result.signal.expectedSemantic === "forgejo.pull_request_label_added" ||
          result.signal.expectedSemantic === undefined,
        true,
        name,
      );
    }
  });

  it("uses X-Forgejo-Event-Type to separate issue and pull-request comments", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const issue = classifyNamed(fixtures, "issue-comment-created");
    const pull = classifyNamed(fixtures, "pull-request-comment-created");
    assert.equal(issue.kind, "event");
    assert.equal(pull.kind, "event");
    if (issue.kind !== "event" || pull.kind !== "event") return;
    assert.equal(issue.event.semanticEvent, "forgejo.issue_comment_created");
    assert.equal(pull.event.semanticEvent, "forgejo.pull_request_comment_created");
    assert.equal(issue.event.rawFamily, "forgejo.issue_comment");
    assert.equal(pull.event.rawFamily, "forgejo.issue_comment");
  });

  it("requires the Forgejo sender on push and never copies an empty actor", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const delivery = deliveryByName(fixtures, "push-default-branch");
    const result = classifyNamed(fixtures, "push-default-branch");
    assert.equal(result.kind, "event");
    if (result.kind !== "event") return;
    assert.equal(result.event.context.actor.login, "t00admin");
    assert.equal(result.event.defaultBranchPush, true);
    assert.equal(recordOf(delivery.payload)["pusher"] !== undefined, true);
    const missingSender = classifyForgejoPayload({
      deliveryId: "00000000-0000-4000-8000-000000000001",
      event: "push",
      eventType: "push",
      payload: { ...recordOf(delivery.payload), sender: undefined },
      connection: CONNECTION,
    });
    assert.equal(missingSender.kind, "unclassified");
  });
});

function classifyNamed(
  fixtures: Awaited<ReturnType<typeof loadForgejoContractFixtures>>,
  name: string,
) {
  const delivery = deliveryByName(fixtures, name);
  return classifyForgejoPayload({
    deliveryId: String(delivery.headers["x-forgejo-delivery"]),
    event: delivery.event,
    eventType: delivery.eventType,
    payload: recordOf(delivery.payload),
    connection: CONNECTION,
  });
}

function recordOf(value: unknown): Record<string, unknown> {
  assert.equal(isRecord(value), true);
  if (!isRecord(value)) throw new Error("expected object");
  return value;
}
