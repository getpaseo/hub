import { test } from "./app.js";

// The money test: organization creation starts and synchronously stamps the hosted trial, so its
// owner lands with paid-plan access. The following Stripe webhook is an idempotent replay, and a
// terminal cancellation returns enforcement to the Free floor and exposes the paywall.
//
// No Stripe account and no network — the fixture Stripe client stands in for checkout, and the
// subscription webhook is HMAC-signed with a known secret so signature verification is real.

const owner = {
  name: "Nadia",
  email: "nadia-billing@example.com",
  password: "nadia-billing-password",
};
const invitee = "teammate-billing@example.com";
const fallbackOwner = {
  name: "Farah",
  email: "farah-billing-fallback@example.com",
  password: "farah-billing-fallback-password",
};

const SLICE_6_DIR = "e2e/screenshots/slice-6";

test.use({ billing: true });

test("a new organization starts trialing, replay is a no-op, and cancellation exposes the paywall", async ({
  hub,
  page,
}) => {
  test.slow();
  await test.step("sign up and create an organization already trialing the hosted plan", async () => {
    await hub.expectUnsupportedSignupPlanIgnored("owner", "bogus");
    await hub.signUpAsWithPlanIntent("owner", owner, "trial");
    // The validated marketing intent survives the account-creation round trip in an HTTP-only
    // cookie, ready for the subsequent organization creation request.
    await hub.expectSignupPlanCookie("owner", "trial");
    await hub.createOrganization("owner", "Acme");
    await hub.expectCurrentPlan("owner", "Hosted");
    await hub.expectActiveTrial("owner");
    await hub.expectReportedSeatQuantity("owner", 1);
    await page.screenshot({ path: `${SLICE_6_DIR}/01-hosted-trial.png`, fullPage: true });
  });

  await test.step("the same invite now succeeds and the second seat is reported to Stripe", async () => {
    await hub.inviteMember("owner", invitee, "member");
    await hub.expectPendingInvitation("owner", invitee);
    // The pending invitation is a reserved seat: billing re-reports the count as two.
    await hub.expectReportedSeatQuantity("owner", 2);
    await page.screenshot({ path: `${SLICE_6_DIR}/02-invite-succeeds.png`, fullPage: true });
  });

  await test.step("replaying the subscription webhook changes nothing", async () => {
    await hub.deliverSubscriptionWebhook("owner");
    await hub.expectCurrentPlan("owner", "Hosted");
    await hub.expectActiveTrial("owner");
    await hub.expectPendingInvitation("owner", invitee);
  });

  await test.step("canceling the subscription reverts entitlements and blocks inviting again", async () => {
    // A portal cancellation delivers customer.subscription.deleted; reconciliation reads the
    // canceled state and stamps the free floor, so paid entitlements do not outlive the
    // subscription.
    await hub.cancelSubscription("owner");
    await hub.expectInviteLockedByPlan("owner");
    // Enforcement reverts to the zero-execution floor; the customer-facing page says only that
    // there is no subscription, and offers the plan again.
    await hub.expectNoSubscription("owner");
    await page.screenshot({ path: `${SLICE_6_DIR}/03-cancel-reverts.png`, fullPage: true });
    // The trial was consumed by the cancelled subscription, so the paywall now sells the plan
    // instead of promising another 14 free days.
    await hub.expectNoSecondTrialOffer("owner");
    await hub.openPlanDialog("owner");
    await page.screenshot({ path: `${SLICE_6_DIR}/04-paid-paywall.png`, fullPage: true });
  });
});

test("a failed creation-time trial leaves the Checkout fallback available", async ({ hub }) => {
  await hub.failNextTrialCreation();
  await hub.signUpAsWithPlanIntent("fallback-owner", fallbackOwner, "trial");
  await hub.createOrganization("fallback-owner", "Fallback Co");

  await hub.expectNoSubscription("fallback-owner");
  await hub.expectInviteLockedByPlan("fallback-owner");
  await hub.expectCardlessTrialOffer("fallback-owner");
  await hub.choosePlan("fallback-owner", "Hosted");
  await hub.deliverSubscriptionWebhook("fallback-owner");
  await hub.expectCurrentPlan("fallback-owner", "Hosted");
  await hub.expectActiveTrial("fallback-owner");
});
