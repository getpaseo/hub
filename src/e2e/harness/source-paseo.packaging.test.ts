import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { packagePaseoArtifacts } from "./source-paseo.js";

/**
 * Packing the source workspaces is the most expensive thing the hub e2e harness does, and it
 * runs from `beforeEach`. These assertions are about the sharing, not the packing: a missing
 * checkout fails fast, which is all the identity checks need.
 */
describe("packaged source artifacts", () => {
  it("builds one tree per source checkout, however many daemons ask for it", () => {
    const first = packagePaseoArtifacts("/nonexistent/paseo-checkout");
    const second = packagePaseoArtifacts("/nonexistent/paseo-checkout");

    assert.equal(first, second, "a second start must wait on the first build, not begin another");
    return Promise.allSettled([first, second]);
  });

  it("keeps separate checkouts apart", () => {
    const one = packagePaseoArtifacts("/nonexistent/paseo-one");
    const other = packagePaseoArtifacts("/nonexistent/paseo-other");

    assert.notEqual(one, other);
    return Promise.allSettled([one, other]);
  });

  it("reports the same failure to every caller rather than retrying a checkout that cannot pack", async () => {
    const failures = await Promise.allSettled([
      packagePaseoArtifacts("/nonexistent/paseo-unpackable"),
      packagePaseoArtifacts("/nonexistent/paseo-unpackable"),
    ]);

    assert.deepEqual(
      failures.map((result) => result.status),
      ["rejected", "rejected"],
    );
  });
});
