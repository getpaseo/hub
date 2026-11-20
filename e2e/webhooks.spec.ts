import { expect } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

test("creates a webhook and reveals each secret only once", async ({ hub, page }) => {
  await hub.signUpAs("owner", {
    name: "Webhook Owner",
    email: "webhook-owner@example.com",
    password: "webhook-owner-password",
  });
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  const triggers = new OrganizationTriggers(page);

  const endpoint = await test.step("create the webhook trigger and open its settings", async () => {
    await triggers.open();
    await triggers.startNew();
    await triggers.configureWebhook(daemon);
    await triggers.save("webhook-alert");
    await triggers.openTrigger("webhook-alert");
    return triggers.expectWebhookEndpoint();
  });
  const first = await triggers.issueWebhookSecret("Create secret");
  await triggers.reloadWebhookSettings();
  const rotated = await triggers.issueWebhookSecret("Rotate secret");
  expect(rotated).not.toEqual(first);
  await triggers.reloadWebhookSettings();
  expect(await triggers.expectWebhookEndpoint()).toEqual(endpoint);
});
