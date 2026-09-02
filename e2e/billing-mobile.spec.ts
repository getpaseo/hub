import { test } from "./app.js";

// A customer first meets the active trial card. After cancellation, the paywall picker must not
// push the page sideways and its paid call to action must remain reachable at phone width.

const owner = {
  name: "Nadia",
  email: "nadia-mobile-billing@example.com",
  password: "nadia-mobile-billing-password",
};

const SCREENSHOT_DIR = "e2e/screenshots/billing-mobile";

test.use({ billing: true });

test("the automatic cardless trial and post-trial paywall fit a phone", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");

  await test.step("the automatically started trial is readable on a phone", async () => {
    await hub.expectActiveTrial("owner");
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-active-trial.png`, fullPage: true });
  });

  await test.step("after cancellation, the paid plan picker fits the viewport", async () => {
    await hub.cancelSubscription("owner");
    await hub.expectNoSubscription("owner");
    await hub.expectPlanPickerFitsPhone("owner");
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-plan-picker.png`, fullPage: true });
  });
});
