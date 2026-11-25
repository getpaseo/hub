import { expect } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationHome } from "./helpers/home.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

test("creates a webhook with a secret that the copied request already carries", async ({
  hub,
  page,
}) => {
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

  const created = await test.step("create the webhook and land on its endpoint", async () => {
    await triggers.open();
    await triggers.startNew();
    await triggers.configureWebhook(daemon);
    return triggers.createWebhookTrigger("webhook-alert");
  });

  await test.step("copy a request that carries the secret shown once", async () => {
    await triggers.copyWebhookUrl(created.endpoint);
    expect(await triggers.copyCurlExample(created.endpoint)).toContain(
      `-H 'Authorization: Bearer ${created.secret}'`,
    );
  });

  await test.step("forget the secret once the reader leaves through history", async () => {
    await triggers.returnThroughHistory();
  });

  await test.step("hide the secret after a reload and ask for the saved one", async () => {
    await triggers.reloadWebhookSettings();
    expect(await triggers.copyCurlExample(created.endpoint)).toContain(
      '-H "Authorization: Bearer $WEBHOOK_SECRET"',
    );
    expect(await triggers.expectWebhookEndpoint()).toEqual(created.endpoint);
  });

  await test.step("rotate to a new secret that the request carries instead", async () => {
    const rotated = await triggers.rotateWebhookSecret();
    expect(rotated).not.toEqual(created.secret);
    expect(await triggers.copyCurlExample(created.endpoint)).toContain(`Bearer ${rotated}`);
    await triggers.rotateWebhookSecretUnsuccessfully();
    expect(await triggers.copyCurlExample(created.endpoint)).toContain(
      '-H "Authorization: Bearer $WEBHOOK_SECRET"',
    );
    await triggers.rotateWebhookSecret();
    await triggers.returnThroughHistory();
    expect(await triggers.copyCurlExample(created.endpoint)).toContain(
      '-H "Authorization: Bearer $WEBHOOK_SECRET"',
    );
  });

  await test.step("say where the secret is once the trigger exists", async () => {
    await home.open();
    await home.expectCurrentStep("Run it");
    await home.expectStepText(
      "Run it",
      "Send a POST to the webhook URL with the secret from the trigger editor",
    );
  });

  await test.step("show both ways to start a trigger after editing its YAML", async () => {
    await triggers.open();
    await triggers.openTrigger("webhook-alert");
    await triggers.addScheduleBeforeWebhook();
    await triggers.save("webhook-alert");
    await home.open();
    await home.expectStepText("Run it", "Runs on its schedule");
    await home.expectStepText("Run it", "Send a POST to the webhook URL");
  });

  await test.step("show the secret when a saved trigger starts listening for webhooks", async () => {
    await triggers.open();
    await triggers.startNew();
    await triggers.configureManual({
      name: "manual-alert",
      daemon,
      cwd: "/workspace/acme",
      agent: "opencode/gateway/vendor/model-v1",
      prompt: "Summarize the alert.",
    });
    await triggers.save("manual-alert");
    await triggers.openTrigger("manual-alert");
    const changed = await triggers.changeToWebhook("manual-alert");
    expect(await triggers.copyCurlExample(changed.endpoint)).toContain(`Bearer ${changed.secret}`);
  });

  await test.step("accept the copied request as it is pasted into a shell", async () => {
    await triggers.open();
    await triggers.openTrigger("webhook-alert");
    const secret = await triggers.rotateWebhookSecret();
    const request = await triggers.copyCurlExample(created.endpoint);
    expect(request).toContain(`Bearer ${secret}`);
    expect(await triggers.runInShell(request)).toBe("202");
  });
});
