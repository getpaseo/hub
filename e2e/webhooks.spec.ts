import { expect } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationHome } from "./helpers/home.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

test("creates a webhook and reveals each secret only once", async ({ hub, page }) => {
  test.slow();
  await hub.signUpAs("owner", {
    name: "Webhook Owner",
    email: "webhook-owner@example.com",
    password: "webhook-owner-password",
  });
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  const home = new OrganizationHome(page);
  const triggers = new OrganizationTriggers(page);

  const endpoint = await test.step("create the webhook trigger and open its settings", async () => {
    await triggers.open();
    await triggers.startNew();
    await triggers.configureWebhook(daemon);
    await triggers.save("webhook-alert");
    await home.open();
    await home.expectCurrentStep("Run it");
    await home.expectStepText(
      "Run it",
      "Send a POST to the webhook URL with the secret from the trigger editor.",
    );
    await triggers.open();
    await triggers.openTrigger("webhook-alert");
    return triggers.expectWebhookEndpoint();
  });
  await triggers.copyWebhookConnectionDetails(endpoint);
  const secondTab = await triggers.openWebhookInAnotherTab();
  const first = await triggers.createWebhookSecret();
  await secondTab.expectStaleWebhookCreationRefused();
  await triggers.reloadWebhookSettings();
  const rotated = await triggers.rotateWebhookSecret();
  expect(rotated).not.toEqual(first);
  await triggers.reloadWebhookSettings();
  expect(await triggers.expectWebhookEndpoint()).toEqual(endpoint);

  await test.step("show both ways to start a trigger after editing its YAML", async () => {
    await triggers.addScheduleBeforeWebhook();
    await triggers.save("webhook-alert");
    await home.open();
    await home.expectStepText("Run it", "It runs on its schedule.");
    await home.expectStepText("Run it", "Send a POST to the webhook URL");
  });
});
