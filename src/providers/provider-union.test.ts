import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { CONNECTION_PROVIDERS } from "../db/schema.js";
import type { ConnectionProvider } from "../db/types.js";
import type { FailureContext } from "../failures/index.js";
import type { logProviderEventIntake } from "../triggers/audit.js";
import { summarizeTrigger, type TriggerSummary } from "../projects/activity-summary.js";

/**
 * The provider union is spelled out in several modules that cannot all import each other. These
 * assignments are the guard: adding a provider to one spelling without the others stops this file
 * from compiling. They have to be compile-time, because a provider missing from a switch or a
 * lookup table never reaches runtime to be asserted on.
 */
describe("connection provider union", () => {
  it("lists every provider exactly once in the schema constant", () => {
    assert.equal(new Set(CONNECTION_PROVIDERS).size, CONNECTION_PROVIDERS.length);
  });

  it("agrees on the provider union across the schema, audit, failures, and activity surfaces", () => {
    // Each assignment must compile. If a surface's provider type widens (e.g. audit gains a
    // new literal) but ConnectionProvider doesn't, backToSchema fails. If ConnectionProvider
    // gains a new member but a surface forgets to widen, the forward assignment fails.

    const fromSchema: ConnectionProvider = CONNECTION_PROVIDERS[0];
    const backToSchema: (typeof CONNECTION_PROVIDERS)[number] = fromSchema;

    // audit.ts: provider must be exactly ConnectionProvider (no wider, no narrower)
    const auditProvider: Parameters<typeof logProviderEventIntake>[0]["provider"] = fromSchema;
    const backFromAudit: ConnectionProvider = auditProvider;

    // failures/index.ts: provider accepts ConnectionProvider (may also accept "stripe")
    const failureProvider: FailureContext["provider"] = fromSchema;

    // activity-summary.ts: provider accepts ConnectionProvider (may also accept "manual")
    const summaryProvider: TriggerSummary["provider"] = fromSchema;

    assert.ok(CONNECTION_PROVIDERS.includes(backToSchema));
    assert.equal(backFromAudit, fromSchema);
    assert.equal(failureProvider, fromSchema);
    assert.equal(summaryProvider, fromSchema);
  });

  it("summarizes an event from every provider as that provider, never as a manual run", () => {
    // The compile-time half above only proves the *type* admits every provider. This is the
    // runtime half: summarizeTrigger dispatches on the source prefix, and a provider without a
    // branch there does not fail — it quietly reports a person's message as a manual run.
    for (const provider of CONNECTION_PROVIDERS) {
      const summary = summarizeTrigger(`${provider}.mention`, {});
      assert.equal(summary.provider, provider);
    }

    assert.equal(summarizeTrigger("manual.run", {}).provider, "manual");
    assert.equal(summarizeTrigger("", {}).provider, "manual");
  });
});
