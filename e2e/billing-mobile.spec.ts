import { test } from "./app.js";

// A customer first meets the Free plan card. The upgrade picker must not push the page sideways
// and its paid call to action must remain reachable at phone width.

const owner = {
  name: "Nadia",
  email: "nadia-mobile-billing@example.com",
  password: "nadia-mobile-billing-password",
};

const SCREENSHOT_DIR = "e2e/screenshots/billing-mobile";

test.use({ billing: true });

test("the Free plan and its upgrade picker fit a phone", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");

  await test.step("the Free plan and its allowance are readable on a phone", async () => {
    await hub.expectFreePlan("owner", 0);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-free-plan.png`, fullPage: true });
  });

  await test.step("the plan picker fits the viewport", async () => {
    await hub.expectPlanPickerFitsPhone("owner");
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-plan-picker.png`, fullPage: true });
  });
});
