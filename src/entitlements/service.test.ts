import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { effectiveEntitlements, hashTemplate, UNLIMITED_TEMPLATE } from "./catalog.js";
import { EntitlementsService } from "./service.js";

describe("EntitlementsService", () => {
  it("throws reading an organization that was never stamped", async () => {
    const service = new EntitlementsService(createMemoryDatabase());
    await assert.rejects(() => service.read("org-1"));
  });

  it("stamps the unlimited default template and reads it back as effective", async () => {
    const service = new EntitlementsService(createMemoryDatabase());
    await service.stamp("org-1", UNLIMITED_TEMPLATE, {
      source: "provisioning",
      planId: null,
      actor: "user-1",
    });

    const record = await service.read("org-1");

    assert.deepEqual(record.granted, UNLIMITED_TEMPLATE);
    assert.deepEqual(record.overrides, {});
    assert.deepEqual(record.effective, UNLIMITED_TEMPLATE);
    assert.equal(record.planId, null);
    assert.equal(record.planVersion, hashTemplate(UNLIMITED_TEMPLATE));
  });

  it("re-stamping replaces granted without touching overrides", async () => {
    const database = createMemoryDatabase();
    const service = new EntitlementsService(database);
    await service.stamp("org-1", UNLIMITED_TEMPLATE, { source: "provisioning", planId: null });
    const capped = { seats: { max: 3 }, canInviteMembers: false };

    await service.stamp("org-1", capped, { source: "plan_stamp", planId: "plan-solo" });
    const record = await service.read("org-1");

    assert.deepEqual(record.granted, capped);
    assert.equal(record.planId, "plan-solo");
    assert.deepEqual(record.overrides, {});
  });

  it("rejects stamping an invalid template", async () => {
    const service = new EntitlementsService(createMemoryDatabase());
    await assert.rejects(() =>
      service.stamp(
        "org-1",
        { seats: { max: -1 }, canInviteMembers: true },
        { source: "provisioning", planId: null },
      ),
    );
  });
});

describe("effectiveEntitlements", () => {
  it("lets an override win over the granted value, key by key", () => {
    const effective = effectiveEntitlements(UNLIMITED_TEMPLATE, {
      seats: { max: 2 },
    });

    assert.deepEqual(effective, { seats: { max: 2 }, canInviteMembers: true });
  });

  it("falls back to granted when no override is set", () => {
    const effective = effectiveEntitlements(UNLIMITED_TEMPLATE, {});
    assert.deepEqual(effective, UNLIMITED_TEMPLATE);
  });
});
