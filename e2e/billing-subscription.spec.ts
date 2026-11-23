import { test } from "./app.js";

// The money test: a new organization lands on the Free plan with its allowance and an upgrade,
// buying the paid plan unlocks what Free caps, the following Stripe webhook is an idempotent
// replay, and a terminal cancellation returns the organization to Free with the meter back.
//
// No Stripe account and no network — the fixture Stripe client stands in for checkout, and the
// subscription webhook is HMAC-signed with a known secret so signature verification is real.

const owner = {
  name: "Nadia",
  email: "nadia-billing@example.com",
  password: "nadia-billing-password",
};
const invitee = "teammate-billing@example.com";
const allowanceOwner = {
  name: "Farah",
  email: "farah-billing-allowance@example.com",
  password: "farah-billing-allowance-password",
};

const SLICE_6_DIR = "e2e/screenshots/slice-6";

test.use({ billing: true });

test("a new organization lands on Free, upgrading unlocks the plan, and cancelling returns it", async ({
  hub,
  page,
}) => {
  test.slow();
  await test.step("sign up and create an organization already on the Free plan", async () => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    // No card, no Stripe subscription, and nothing counting down: the organization is simply on
    // a plan. The sidebar carries the allowance and the way to more of it.
    await hub.expectExecutionMeter("owner", 0);
    await hub.expectReportedSeatQuantity("owner", null);
    await hub.expectFreePlan("owner", 0);
    await page.screenshot({ path: `${SLICE_6_DIR}/01-free-plan.png`, fullPage: true });
  });

  await test.step("Free caps invitations, and the lock leads to the offer", async () => {
    await hub.expectInviteLockedByPlan("owner");
    await hub.expectUpgradeOffer("owner");
    await page.screenshot({ path: `${SLICE_6_DIR}/02-upgrade-offer.png`, fullPage: true });
    await hub.dismissPlanDialog("owner");
  });

  await test.step("buying the paid plan stamps it and retires the meter", async () => {
    await hub.subscribeToPlan("owner", "Pro");
    await hub.deliverSubscriptionWebhook("owner");
    await hub.expectPaidPlan("owner");
    await hub.expectNoExecutionMeter("owner");
    await hub.expectReportedSeatQuantity("owner", 1);
    await page.screenshot({ path: `${SLICE_6_DIR}/03-paid-plan.png`, fullPage: true });
  });

  await test.step("the invite Free blocked now succeeds and the second seat is reported", async () => {
    await hub.inviteMember("owner", invitee, "member");
    await hub.expectPendingInvitation("owner", invitee);
    // The pending invitation is a reserved seat: billing re-reports the count as two.
    await hub.expectReportedSeatQuantity("owner", 2);
    await page.screenshot({ path: `${SLICE_6_DIR}/04-invite-succeeds.png`, fullPage: true });
  });

  await test.step("replaying the subscription webhook changes nothing", async () => {
    await hub.deliverSubscriptionWebhook("owner");
    await hub.expectPaidPlan("owner");
    await hub.expectPendingInvitation("owner", invitee);
  });

  await test.step("cancelling returns the organization to Free, meter and all", async () => {
    // A portal cancellation delivers customer.subscription.deleted; reconciliation reads the
    // canceled state and stamps Free, so paid entitlements do not outlive the subscription.
    await hub.cancelSubscription("owner");
    await hub.expectInviteLockedByPlan("owner");
    await hub.expectFreePlan("owner", 0);
    // And the allowance is back in the sidebar rather than an organization left with nothing.
    await hub.expectExecutionMeter("owner", 0);
    await page.screenshot({ path: `${SLICE_6_DIR}/05-cancel-returns-free.png`, fullPage: true });
  });
});

test("raising the Free allowance in Stripe re-stamps the organizations on it", async ({ hub }) => {
  // The whole migration mechanism for a plan change: edit the product in the Stripe dashboard and
  // the product webhook's resync carries every organization on that plan onto the new template.
  // This is what gives an organization stamped under an older Free its new allowance, with no
  // backfill to run.
  await hub.signUpAs("allowance-owner", allowanceOwner);
  await hub.createOrganization("allowance-owner", "Globex");
  await hub.expectExecutionMeter("allowance-owner", 0);

  await hub.raiseFreeExecutionAllowance(500);

  await hub.expectExecutionMeter("allowance-owner", 0, 500);
});
