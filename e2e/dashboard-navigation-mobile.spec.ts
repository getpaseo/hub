import { expect } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";

const SHOTS = "e2e/screenshots/dashboard-navigation-mobile";

const owner = {
  name: "Alice",
  email: "alice-navigation-mobile@example.com",
  password: "alice-navigation-mobile-password",
};

/** The drawer is where a stacked list of destinations hurts most: it is the whole screen. */
test("stacks two switchers but one set of destinations in the mobile drawer", async ({
  hub,
  page,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const drawer = page.getByRole("dialog", { name: "Sidebar" });
  const toggle = page.getByRole("button", { name: "Toggle Sidebar" });
  const organizationSwitcher = drawer.getByRole("button", { name: "Organization" });
  const projectSwitcher = drawer.getByRole("button", { name: "Project", exact: true });

  await test.step("organization scope", async () => {
    await toggle.click();
    await expect(
      drawer.getByRole("navigation", { name: "Organization", exact: true }),
    ).toBeVisible();
    await expect(drawer.getByRole("navigation", { name: "Project", exact: true })).toHaveCount(0);
    await expect(organizationSwitcher).toContainText("Acme");
    await expect(projectSwitcher).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/01-organization-scope.png` });
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });

  await test.step("project scope keeps the organization switcher and swaps the destinations", async () => {
    await app.navigation.openProject("Default");
    await toggle.click();
    await expect(organizationSwitcher).toContainText("Acme");
    await expect(projectSwitcher).toContainText("Default");
    await expect(drawer.getByRole("navigation", { name: "Organization", exact: true })).toHaveCount(
      0,
    );
    await expect(drawer.getByRole("link", { name: "All projects" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/02-project-scope.png` });
  });

  await test.step("the back row leaves the project and dismisses the drawer", async () => {
    await app.navigation.leaveProject();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  });
});

test.describe("instance scope", () => {
  test("enters instance scope through the drawer's account menu", async ({ hub, page }) => {
    const app = projectApp(page);
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await hub.grantOperator("owner");
    const drawer = page.getByRole("dialog", { name: "Sidebar" });
    const instanceNav = drawer.getByRole("navigation", { name: "Instance", exact: true });

    await app.navigation.openProject("Default");
    // The account menu opens inside the drawer that covers the destination, so leaving for the
    // instance has to dismiss it — otherwise the operator arrives behind the sidebar.
    await app.navigation.openMobileInstanceSection(owner.email, "Operator");
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("heading", { name: "Operator", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(instanceNav.getByRole("link")).toHaveText(["Back to Acme", "Apps", "Operator"]);
    await expect(drawer.getByRole("button", { name: "Organization" })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/03-instance-scope.png` });

    await app.navigation.leaveInstance();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  });
});
