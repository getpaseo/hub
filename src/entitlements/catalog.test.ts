import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { entitlementsSchema, hashTemplate, type EntitlementTemplate } from "./catalog.js";

/**
 * `plan_version` is this hash, and the catalog sync re-stamps every organization whose stored
 * hash differs from its plan's. Two templates that mean the same thing must therefore hash the
 * same, whatever order their keys were built in — otherwise a plan and an organization that
 * agree would re-stamp each other forever.
 */
describe("hashTemplate", () => {
  const template: EntitlementTemplate = {
    seats: { max: 1 },
    canInviteMembers: false,
    meters: { "executions.monthly": { limit: 50 } },
  };

  it("hashes the same template the same way whatever order its keys were written in", () => {
    const reordered = {
      meters: { "executions.monthly": { limit: 50 } },
      canInviteMembers: false,
      seats: { max: 1 },
    } as EntitlementTemplate;

    assert.equal(hashTemplate(reordered), hashTemplate(template));
    // And through the schema, which is the only way a template reaches a stamp today.
    assert.equal(hashTemplate(entitlementsSchema.parse(reordered)), hashTemplate(template));
  });

  it("separates templates that differ in any value", () => {
    assert.notEqual(hashTemplate({ ...template, seats: { max: 2 } }), hashTemplate(template));
    assert.notEqual(
      hashTemplate({ ...template, meters: { "executions.monthly": { limit: null } } }),
      hashTemplate(template),
    );
    assert.notEqual(hashTemplate({ ...template, canInviteMembers: true }), hashTemplate(template));
  });
});
