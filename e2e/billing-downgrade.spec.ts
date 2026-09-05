import { test } from "./app.js";

// Slice 7: losing a plan, over-limit, and provenance.
//
// Hub sells one plan, so the downgrade a customer can actually reach is cancellation: enforcement
// drops from the plan's template to the internal free floor. That drop never deletes members or
// invitations to fit the smaller cap — existing seats are grandfathered — but it blocks growth
// past the new cap and surfaces a banner. The granted/overrides split is proven directly: a manual
// override survives a plan change while everything the admin did not touch is re-stamped, and
// clearing the override hands that value back to the plan.
//
// No Stripe account and no network: the fixture stands in for checkout, and each subscription
// webhook is HMAC-signed with a known secret so signature verification is real.

const DIR = "e2e/screenshots/slice-7";
const PLAN = "Hosted";

test.use({ billing: true });

const downgradeOwner = {
  name: "Priya",
  email: "priya-downgrade@example.com",
  password: "priya-downgrade-password",
};
const invitees = [
  "one-downgrade@example.com",
  "two-downgrade@example.com",
  "three-downgrade@example.com",
  "four-downgrade@example.com",
];

test("losing the plan keeps every seat, warns that the org is over its limit, and blocks a new invite", async ({
  hub,
  page,
}) => {
  test.slow();
  await test.step("create an organization on the hosted trial", async () => {
    await hub.signUpAs("owner", downgradeOwner);
    await hub.createOrganization("owner", "Acme");
    await hub.expectCurrentPlan("owner", PLAN);
    await hub.expectActiveTrial("owner");
  });

  await test.step("fill five seats: the owner plus four invited members", async () => {
    await hub.inviteMembers("owner", invitees);
    await hub.expectPendingInvitationsRetained("owner", invitees);
    await page.screenshot({ path: `${DIR}/01-five-seats.png`, fullPage: true });
  });

  await test.step("cancel the subscription, which drops the org to the one-seat floor", async () => {
    await hub.cancelSubscription("owner");
    await hub.expectNoSubscription("owner");
  });

  await test.step("all five seats are grandfathered and an over-limit banner explains the state", async () => {
    await hub.expectPendingInvitationsRetained("owner", invitees);
    await hub.expectOverLimitBanner("owner", { used: 5, limit: 1 });
    await page.screenshot({ path: `${DIR}/02-over-limit-banner.png`, fullPage: true });
  });

  await test.step("a sixth invite is locked — the floor blocks growth past the cap", async () => {
    await hub.expectInviteLockedByPlan("owner");
    await page.screenshot({ path: `${DIR}/03-invite-locked.png`, fullPage: true });
  });
});

const overrideOwner = {
  name: "Marco",
  email: "marco-override@example.com",
  password: "marco-override-password",
};
const seatReason = "Contractual three-seat cap for the pilot";
const clearReason = "Pilot ended — return to plan-driven seats";

test("a manual override survives a plan change while the rest re-stamps, and clearing it returns control to the plan", async ({
  hub,
  page,
}) => {
  test.slow();
  await test.step("start from a trialing organization and become an operator", async () => {
    await hub.signUpAs("owner", overrideOwner);
    await hub.createOrganization("owner", "Globex");
    await hub.expectCurrentPlan("owner", PLAN);
    await hub.expectActiveTrial("owner");
    // Overrides are operator-only now; the owner is granted the flag to hand-set the deal.
    await hub.grantOperator("owner");
  });

  await test.step("hand-set a three-seat override from the operator console", async () => {
    await hub.openSeatOverrideEditor("owner", { org: "Globex", max: 3, reason: seatReason });
    await hub.saveSeatOverride("owner", 3);
    await hub.expectEntitlementCells("owner", "Globex", "Seats", {
      granted: "Unlimited",
      override: "3",
      effective: "3",
    });
    await hub.expectEntitlementCells("owner", "Globex", "Executions this month", {
      granted: "Unlimited",
      override: "—",
      effective: "Unlimited",
    });
    await page.screenshot({ path: `${DIR}/04-trial-override.png`, fullPage: true });
  });

  await test.step("cancel the trial: the override holds while granted values re-stamp", async () => {
    await hub.cancelSubscription("owner");
    await hub.expectNoSubscription("owner");
    await hub.expectEntitlementCells("owner", "Globex", "Seats", {
      granted: "1",
      override: "3",
      effective: "3",
    });
    await hub.expectEntitlementCells("owner", "Globex", "Executions this month", {
      granted: "0",
      override: "—",
      effective: "0",
    });
    await page.screenshot({ path: `${DIR}/05-override-survives-restamp.png`, fullPage: true });
  });

  await test.step("clear the override: the Free floor takes control, and the reset is audited", async () => {
    await hub.clearSeatOverride("owner", {
      org: "Globex",
      reason: clearReason,
      expectedEffective: "1",
    });
    await hub.expectEntitlementCells("owner", "Globex", "Seats", {
      granted: "1",
      override: "—",
      effective: "1",
    });
    await hub.expectEntitlementsAudit("owner", {
      org: "Globex",
      actor: overrideOwner.name,
      reason: clearReason,
    });
    await page.screenshot({ path: `${DIR}/06-override-cleared.png`, fullPage: true });
  });
});
