import { test } from "./app.js";

const owner = {
  name: "Farah",
  email: "farah-billing@example.com",
  password: "farah-billing-password",
};

const SLICE_4_DIR = "e2e/screenshots/slice-4";

test("a self-hosted instance without STRIPE_SECRET_KEY has no billing surface", async ({
  hub,
  page,
}) => {
  await test.step("sign up and land in a new organization", async () => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
  });

  await test.step("the sidebar has no billing navigation entry", async () => {
    await hub.expectNoBillingNavigation("owner");
    await page.screenshot({
      path: `${SLICE_4_DIR}/01-no-billing-navigation.png`,
      fullPage: true,
    });
  });

  await test.step("the billing settings page 404s", async () => {
    await hub.expectBillingPageUnavailable("owner");
    await page.screenshot({ path: `${SLICE_4_DIR}/02-billing-page-404.png`, fullPage: true });
  });

  await test.step("the billing webhook endpoint 404s", async () => {
    await hub.expectBillingWebhookUnavailable();
  });
});
