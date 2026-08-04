import { test } from "./app.js";
import { expectMobileOverlayDismissed } from "./helpers/projects/assertions.js";
import { projectApp } from "./helpers/projects/index.js";

const owner = {
  name: "Alice",
  email: "alice-mobile-projects@example.com",
  password: "alice-mobile-projects-password",
};

test("dismisses the mobile project navigation overlay and keeps the route within the viewport", async ({
  hub,
  page,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.navigation.openProject("Default");
  await app.navigation.openMobileProjectSection("Configuration");
  await expectMobileOverlayDismissed(page);
});
