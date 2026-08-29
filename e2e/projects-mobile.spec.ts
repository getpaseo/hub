import { test } from "./app.js";
import { expect } from "@playwright/test";
import { expectMobileOverlayDismissed } from "./helpers/projects/assertions.js";
import { projectApp } from "./helpers/projects/index.js";

const owner = {
  name: "Alice",
  email: "alice-mobile-projects@example.com",
  password: "alice-mobile-projects-password",
};

test("project failures and navigation stay contained on mobile", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.primaryApplication().failNextProjectRead();

  await page.getByRole("link", { name: "Default" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Project unavailable");
  await expect(alert).toContainText(
    "Hub couldn't load this project's configuration. Reload the page to try again.",
  );
  await expect(alert).toBeInViewport();
  await expect.poll(() => hub.primaryApplication().logs()).toContain("project.read failed");
  expect(hub.primaryApplication().logs()).not.toContain("formatless-project-secret-8ac72f");

  await hub.returnToProjects("owner");
  await app.navigation.openProject("Default");
  await app.navigation.openMobileProjectSection("Configuration");
  await expectMobileOverlayDismissed(page);
});
