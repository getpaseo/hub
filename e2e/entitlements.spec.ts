import { test } from "./app.js";

const owner = {
  name: "Amara",
  email: "amara-entitlements@example.com",
  password: "amara-entitlements-password",
};

const SCREENSHOT_DIR = "e2e/screenshots/slice-1";

test("shows the unlimited default entitlements for a newly provisioned organization", async ({
  hub,
  page,
}) => {
  await test.step("sign up and land in a new organization", async () => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-new-organization.png`,
      fullPage: true,
    });
  });

  await test.step("open the entitlements page and see the unlimited defaults", async () => {
    await hub.expectEntitlements("owner");
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-entitlements-unlimited-defaults.png`,
      fullPage: true,
    });
  });
});
