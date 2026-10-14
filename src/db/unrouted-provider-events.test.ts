import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import {
  createActiveProjectConfiguration,
  TEST_DAEMON_SLUG,
} from "../test-utils/project-configuration.js";
import {
  PROVIDER_EVENT_DROP_REASON_CODES,
  UNROUTED_PROVIDER_EVENT_DROP_REASON_CODES,
  type ProviderEventDropReasonCode,
} from "../triggers/drop-reason.js";

// A stop receipt was handled (it stopped the session); it never was "unrouted".
const HANDLED_DROP_REASON_CODES: readonly ProviderEventDropReasonCode[] = ["agent_session_stopped"];

describe("unrouted provider events", () => {
  it("surfaces every unrouted drop reason and hides the handled ones", async () => {
    const database = createMemoryDatabase();
    const organizationId = "unrouted-org";
    const { project } = await createActiveProjectConfiguration(
      database,
      {
        environments: [{ name: "runner", kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/repo" }],
        triggers: [],
      },
      { organizationId },
    );
    const receiptsByReason = new Map<ProviderEventDropReasonCode, string>();
    for (const reason of PROVIDER_EVENT_DROP_REASON_CODES) {
      const receipt = await database.persistManualEvent({
        organizationId,
        projectId: project.id,
        source: "manual.run",
        deliveryId: `delivery-${reason}`,
        receivedAt: new Date(),
        payload: {},
      });
      if (receipt.status !== "accepted") throw new Error("expected accepted receipt");
      await database.markProviderEventDropped(receipt.event.providerEventReceiptId, reason);
      receiptsByReason.set(reason, receipt.event.providerEventReceiptId);
    }

    const unrouted = await database.listUnroutedProviderEventsForOrganization(organizationId);

    assert.deepEqual(
      new Set(unrouted.map((receipt) => receipt.droppedReason)),
      new Set(UNROUTED_PROVIDER_EVENT_DROP_REASON_CODES),
    );
    for (const reason of HANDLED_DROP_REASON_CODES) {
      assert.equal(
        unrouted.some((receipt) => receipt.id === receiptsByReason.get(reason)),
        false,
        `${reason} must not be listed as unrouted`,
      );
    }
  });

  it("keeps the shared list complete: every drop reason is either unrouted or handled", () => {
    assert.deepEqual(
      new Set(PROVIDER_EVENT_DROP_REASON_CODES),
      new Set([...UNROUTED_PROVIDER_EVENT_DROP_REASON_CODES, ...HANDLED_DROP_REASON_CODES]),
    );
  });

  // The Postgres query lists the codes as a SQL literal (no Docker is needed to keep it honest).
  it("keeps the Postgres query on the same unrouted drop reasons as the memory database", async () => {
    const source = await readFile(new URL("./pg.ts", import.meta.url), "utf8");
    const start = source.indexOf("async listUnroutedProviderEventsForOrganization(");
    assert.notEqual(start, -1);
    const body = source.slice(start, source.indexOf("limit 50", start));
    const literal = /dropped_reason in \(([^)]*)\)/.exec(body);
    assert.notEqual(literal, null, "expected a dropped_reason in (...) literal");
    const codes = [...literal![1]!.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    assert.deepEqual(new Set(codes), new Set(UNROUTED_PROVIDER_EVENT_DROP_REASON_CODES));
  });
});
