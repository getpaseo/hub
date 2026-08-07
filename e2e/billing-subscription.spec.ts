import { test } from "./app.js";

// The money test: the proof of the whole decoupled design. A free organization cannot invite;
// a subscription webhook stamps a paid plan onto the organization; enforcement then reads the
// organization's own record and the same invite succeeds. Replaying the webhook changes nothing.
//
// No Stripe account and no network — the fixture Stripe client stands in for checkout, and the
// subscription webhook is HMAC-signed with a known secret so signature verification is real.

const owner = {
  name: "Nadia",
  email: "nadia-billing@example.com",
  password: "nadia-billing-password",
};
const invitee = "teammate-billing@example.com";

const SLICE_6_DIR = "e2e/screenshots/slice-6";

test.use({ billing: true });

test("subscribing lifts a free org's invite limit, and replaying the webhook changes nothing", async ({
  hub,
  page,
}) => {
  await test.step("sign up, create an organization, and put it on the free plan", async () => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await hub.subscribeToPlan("owner", { plan: "Free", interval: "Monthly" });
    await hub.deliverSubscriptionWebhook("owner");
    await hub.expectCurrentPlan("owner", "Free");
    await page.screenshot({ path: `${SLICE_6_DIR}/01-free-plan.png`, fullPage: true });
  });

  await test.step("a free organization with one seat cannot invite", async () => {
    await hub.expectInviteBlockedByPlan("owner", invitee);
    await page.screenshot({ path: `${SLICE_6_DIR}/02-invite-blocked.png`, fullPage: true });
  });

  await test.step("open the upgrade dialog and choose a paid plan", async () => {
    await hub.openPlanDialog("owner");
    await page.screenshot({ path: `${SLICE_6_DIR}/03-upgrade-dialog.png`, fullPage: true });
    await hub.choosePlan("owner", { plan: "Solo", interval: "Monthly" });
  });

  await test.step("the subscription webhook stamps the paid plan onto the organization", async () => {
    await hub.deliverSubscriptionWebhook("owner");
    await hub.expectCurrentPlan("owner", "Solo");
    await page.screenshot({ path: `${SLICE_6_DIR}/04-solo-plan.png`, fullPage: true });
  });

  await test.step("the same invite now succeeds", async () => {
    await hub.inviteMember("owner", invitee, "member");
    await hub.expectPendingInvitation("owner", invitee);
    await page.screenshot({ path: `${SLICE_6_DIR}/05-invite-succeeds.png`, fullPage: true });
  });

  await test.step("replaying the subscription webhook changes nothing", async () => {
    await hub.deliverSubscriptionWebhook("owner");
    await hub.expectCurrentPlan("owner", "Solo");
    await hub.expectPendingInvitation("owner", invitee);
  });
});
