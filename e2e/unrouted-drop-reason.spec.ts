import { expect } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationActivity } from "./helpers/activity.js";

test.use({ providerScenario: "slack-only" });

const PRIVATE =
  /PRIVATE-EVENT-(BODY|SENDER-ID|CHANNEL-ID|ATTACHMENT-ID|ATTACHMENT-NAME)|PRIVATE-SLACK-TOKEN/u;

test("shows a bounded reason for a real signed unrouted event", async ({ hub, page }) => {
  await hub.signUpAs("owner", {
    name: "Alice",
    email: "alice-unrouted-reason@example.com",
    password: "alice-unrouted-reason-password",
  });
  await hub.createOrganization("owner", "Acme");
  await hub.deliverSignedUnroutedSlackEvent("owner");
  const activity = new OrganizationActivity(page);

  await activity.open();
  await activity.show("Unmatched events");
  await activity.expectRows("Unmatched events", 1);
  await expect(activity.rows("Unmatched events").first()).toContainText("Filtered out");
  await expect(activity.table("Unmatched events")).not.toContainText(PRIVATE);
  await activity.openFirstRecord("Unmatched events");
  await activity.expectRecord("Did not pass trigger filters");
});
