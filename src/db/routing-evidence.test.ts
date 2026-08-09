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
    await database.insertAttachment({
      providerEventReceiptId: firstReceipt.event.providerEventReceiptId,
      organizationId: "routing-org-a",
      connectionId: "00000000-0000-4000-8000-000000000099",
      provider: "slack",
      sourceId: "PRIVATE-ATTACHMENT-ID",
      locator: { token: "PRIVATE-ATTACHMENT-TOKEN" },
      filename: "PRIVATE-ATTACHMENT-NAME",
    });

    await database.commitProviderEventRoutingResult({
      organizationId: "routing-org-a",
      providerEventReceiptId: firstReceipt.event.providerEventReceiptId,
      projectId: first.project.id,
      configurationRevisionId: first.revision.id,
      outcome: "dropped",
      decisions: Array.from({ length: 75 }, (_, index) => ({
        triggerName: `candidate-${index}-${"x".repeat(200)}`,
        code: "contains_mismatch" as const,
      })),
    });
    await database.commitProviderEventRoutingResult({
      organizationId: "routing-org-b",
      providerEventReceiptId: secondReceipt.event.providerEventReceiptId,
      projectId: second.project.id,
      configurationRevisionId: second.revision.id,
      outcome: "dropped",
      decisions: [{ triggerName: "other-org-trigger", code: "sender_not_allowed" }],
    });

    const firstEvents = await database.listUnroutedProviderEventsForOrganization("routing-org-a");
    const secondEvents = await database.listUnroutedProviderEventsForOrganization("routing-org-b");
    assert.equal(firstEvents.length, 1);
    assert.equal(secondEvents.length, 1);
    assert.equal(firstEvents[0]?.routingDecisions.length, 25);
    assert.equal(secondEvents[0]?.routingDecisions[0]?.triggerName, "other-org-trigger");
    assert.equal(
      firstEvents[0]?.routingDecisions.every(
        (decision) => decision.triggerName === null || decision.triggerName.length <= 128,
      ),
      true,
    );
    assert.equal(
      firstEvents[0]?.routingDecisions.some(
        (decision) => decision.code === "routing_evidence_truncated",
      ),
      true,
    );
    assert.doesNotMatch(JSON.stringify(firstEvents), /PRIVATE-EVENT-BODY|PRIVATE-SENDER/gu);
    assert.doesNotMatch(JSON.stringify(secondEvents), /PRIVATE-OTHER-BODY/gu);
    assert.equal(
      await database.findAttachmentBySource(
        firstReceipt.event.providerEventReceiptId,
        "slack",
        "PRIVATE-ATTACHMENT-ID",
      ),
      undefined,
    );
    assert.equal(
      firstEvents[0]?.routingDecisions.some((decision) => decision.code === "sender_not_allowed"),
      false,
    );
  });

  it("stores no-trigger evidence once and only when no source-relevant decision exists", async () => {
    const database = createMemoryDatabase();
    const { project, revision } = await createActiveProjectConfiguration(
      database,
      emptyConfiguration(),
      { organizationId: "routing-cardinality-org", projectSlug: "cardinality" },
    );

    const commit = async (
      deliveryId: string,
      decisions: Parameters<typeof database.commitProviderEventRoutingResult>[0]["decisions"],
    ) => {
      const receipt = await database.persistManualEvent({
        organizationId: "routing-cardinality-org",
        projectId: project.id,
        deliveryId,
        source: "manual.run",
        payload: { body: `PRIVATE-${deliveryId}` },
        receivedAt: new Date("2026-08-09T12:00:00.000Z"),
      });
      assert.equal(receipt.status, "accepted");
      if (receipt.status !== "accepted") throw new Error("expected accepted receipt");
      await database.commitProviderEventRoutingResult({
        organizationId: "routing-cardinality-org",
        providerEventReceiptId: receipt.event.providerEventReceiptId,
        projectId: project.id,
        configurationRevisionId: revision.id,
        outcome: "dropped",
        decisions,
      });
    };

    await commit(
      "only-unrelated",
      Array.from({ length: 30 }, (_, index) => ({
        triggerName: `unrelated-${index}`,
        code: "no_trigger_for_source" as const,
      })),
    );
    await commit("source-relevant", [
      { triggerName: null, code: "no_trigger_for_source" },
      { triggerName: "relevant", code: "sender_not_allowed" },
    ]);

    const events =
      await database.listUnroutedProviderEventsForOrganization("routing-cardinality-org");
    const onlyUnrelated = events.find((event) => event.deliveryId === "only-unrelated");
    const sourceRelevant = events.find((event) => event.deliveryId === "source-relevant");
    assert.deepEqual(
      onlyUnrelated?.routingDecisions.map(({ triggerName, code }) => ({ triggerName, code })),
      [{ triggerName: null, code: "no_trigger_for_source" }],
    );
    assert.deepEqual(
      sourceRelevant?.routingDecisions.map(({ triggerName, code }) => ({ triggerName, code })),
      [{ triggerName: "relevant", code: "sender_not_allowed" }],
    );
  });
});

function emptyConfiguration() {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "main", cwd: "/repo" }],
    triggers: [],
  };
}
