import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { readBillingConfig } from "./config.js";

describe("readBillingConfig", () => {
  it("returns undefined when STRIPE_SECRET_KEY is absent", () => {
    assert.equal(readBillingConfig({}), undefined);
  });

  it("returns undefined when STRIPE_SECRET_KEY is blank", () => {
    assert.equal(readBillingConfig({ STRIPE_SECRET_KEY: "   " }), undefined);
  });

  it("returns a config when STRIPE_SECRET_KEY is a well-formed secret key", () => {
    assert.deepEqual(readBillingConfig({ STRIPE_SECRET_KEY: "sk_test_abc123" }), {
      stripeSecretKey: "sk_test_abc123",
    });
  });

  it("throws when STRIPE_SECRET_KEY does not look like a Stripe secret key", () => {
    assert.throws(
      () => readBillingConfig({ STRIPE_SECRET_KEY: "not-a-stripe-key" }),
      /STRIPE_SECRET_KEY is invalid/,
    );
  });
});
