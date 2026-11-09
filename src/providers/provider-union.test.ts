import type {
  ProviderApplicationConfiguration,
  ProviderApplicationIdentity,
} from "../provider-applications/index.js";
import assert from "node:assert/strict";
import { describe, it, expectTypeOf } from "vitest";
import { CONNECTION_PROVIDERS } from "../db/schema.js";
import type { ConnectionProvider } from "../db/types.js";
import type { FailureContext } from "../failures/index.js";
import type { logProviderEventIntake } from "../triggers/audit.js";
import { summarizeTrigger, type TriggerSummary } from "../projects/activity-summary.js";

describe("connection provider union", () => {
  it("lists every provider exactly once in the schema constant", () => {
    assert.equal(new Set(CONNECTION_PROVIDERS).size, CONNECTION_PROVIDERS.length);
  });

  it("agrees on the provider union across the schema, audit, failures, and activity surfaces", () => {
    expectTypeOf<
      ProviderApplicationConfiguration["provider"]
    >().toEqualTypeOf<ConnectionProvider>();
    expectTypeOf<ProviderApplicationIdentity["provider"]>().toEqualTypeOf<ConnectionProvider>();
    expectTypeOf<ConnectionProvider>().toEqualTypeOf<(typeof CONNECTION_PROVIDERS)[number]>();
    expectTypeOf<
      Parameters<typeof logProviderEventIntake>[0]["provider"]
    >().toEqualTypeOf<ConnectionProvider>();
    expectTypeOf<FailureContext["provider"]>().toEqualTypeOf<
      ConnectionProvider | "stripe" | undefined
    >();
    expectTypeOf<TriggerSummary["provider"]>().toEqualTypeOf<
      ConnectionProvider | "manual" | "schedule"
    >();
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
