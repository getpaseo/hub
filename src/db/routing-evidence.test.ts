import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { createActiveProjectConfiguration } from "../test-utils/project-configuration.js";

describe("memory routing evidence persistence", () => {
  it("bounds candidate evidence, stores fixed summaries, and isolates organizations", async () => {
    const database = createMemoryDatabase();
    const first = await createActiveProjectConfiguration(database, emptyConfiguration(), {
      organizationId: "routing-org-a",
      projectSlug: "first",
    });
    const second = await createActiveProjectConfiguration(database, emptyConfiguration(), {
      organizationId: "routing-org-b",
      projectSlug: "second",
    });
    const firstReceipt = await database.persistManualEvent({
      organizationId: "routing-org-a",
      projectId: first.project.id,
      deliveryId: "routing-a",
      source: "manual.run",
      payload: { body: "PRIVATE-EVENT-BODY", sender: "PRIVATE-SENDER" },
      receivedAt: new Date("2026-08-09T12:00:00.000Z"),
    });
    const secondReceipt = await database.persistManualEvent({
      organizationId: "routing-org-b",
      projectId: second.project.id,
      deliveryId: "routing-b",
      source: "manual.run",
      payload: { body: "PRIVATE-OTHER-BODY" },
      receivedAt: new Date("2026-08-09T12:01:00.000Z"),
    });
    assert.equal(firstReceipt.status, "accepted");
    assert.equal(secondReceipt.status, "accepted");
    if (firstReceipt.status !== "accepted" || secondReceipt.status !== "accepted") {
      throw new Error("expected accepted receipts");
    }

    for (const batch of [0, 1, 2]) {
      await database.recordProviderEventRoutingDecisions({
        organizationId: "routing-org-a",
        providerEventReceiptId: firstReceipt.event.providerEventReceiptId,
        projectId: first.project.id,
        configurationRevisionId: first.revision.id,
        decisions: Array.from({ length: 25 }, (_, index) => ({
          triggerName: `candidate-${batch}-${index}-${"x".repeat(200)}`,
          code: "contains_mismatch" as const,
        })),
      });
    }
    await database.recordProviderEventRoutingDecisions({
      organizationId: "routing-org-b",
      providerEventReceiptId: secondReceipt.event.providerEventReceiptId,
      projectId: second.project.id,
      configurationRevisionId: second.revision.id,
      decisions: [{ triggerName: "other-org-trigger", code: "sender_not_allowed" }],
    });

    const firstEvents = await database.listUnroutedProviderEventsForOrganization("routing-org-a");
    const secondEvents = await database.listUnroutedProviderEventsForOrganization("routing-org-b");
    assert.equal(firstEvents.length, 1);
    assert.equal(secondEvents.length, 1);
    assert.equal(firstEvents[0]?.routingDecisions.length, 50);
    assert.equal(secondEvents[0]?.routingDecisions[0]?.triggerName, "other-org-trigger");
    assert.equal(
      firstEvents[0]?.routingDecisions.every((decision) => decision.triggerName!.length <= 128),
      true,
    );
    assert.equal(
      firstEvents[0]?.routingDecisions.every(
        (decision) =>
          decision.summary === "The event does not contain the configured trigger marker.",
      ),
      true,
    );
    assert.doesNotMatch(JSON.stringify(firstEvents), /PRIVATE-EVENT-BODY|PRIVATE-SENDER/gu);
    assert.doesNotMatch(JSON.stringify(secondEvents), /PRIVATE-OTHER-BODY/gu);
    assert.equal(
      firstEvents[0]?.routingDecisions.some((decision) => decision.code === "sender_not_allowed"),
      false,
    );
  });
});

function emptyConfiguration() {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "main", cwd: "/repo" }],
    triggers: [],
  };
}
