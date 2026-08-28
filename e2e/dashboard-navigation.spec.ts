import { expect } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";

const SHOTS = "e2e/screenshots/dashboard-navigation";

const owner = {
  name: "Alice",
  email: "alice-navigation@example.com",
  password: "alice-navigation-password",
};

/**
 * The header stacks where you are; the body swaps to the innermost level. Organization scope
 * offers the three working surfaces plus Settings; entering a project keeps the organization
 * switcher and adds the project's beneath it, while replacing every destination. This is the test
 * that fails if a project ever renders organization destinations again, or ever loses the way to
 * switch organization from inside one.
 */
test("stacks the switchers and swaps the destinations between organization and project", async ({
  hub,
  page,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");

  const organizationNav = page.getByRole("navigation", { name: "Organization", exact: true });
  const projectNav = page.getByRole("navigation", { name: "Project", exact: true });
  const organizationSwitcher = page.getByRole("button", { name: "Organization" });
  const projectSwitcher = page.getByRole("button", { name: "Project", exact: true });

  await test.step("organization scope offers work first and administration behind Settings", async () => {
    await expect(organizationNav.getByRole("link")).toHaveText([
      "Projects",
      "Daemons",
      "Connections",
      "Settings",
    ]);
    await expect(projectNav).toHaveCount(0);
    await expect(projectSwitcher).toHaveCount(0);
    await expect(organizationSwitcher).toContainText("Acme");
    await page.screenshot({ path: `${SHOTS}/01-organization-scope.png`, fullPage: true });
  });

  await test.step("entering a project stacks its switcher under the organization's", async () => {
    await app.navigation.openProject("Default");
    // Tenant identity does not go away when you step into a project, and the way to another
    // organization goes with it.
    await expect(organizationSwitcher).toContainText("Acme");
    await expect(projectSwitcher).toContainText("Default");
    // The organization is the row directly above, so the project switcher does not repeat it.
    await expect(projectSwitcher).not.toContainText("Acme");
    await page.screenshot({ path: `${SHOTS}/02-project-scope.png`, fullPage: true });
  });

  await test.step("the destinations are the project's alone", async () => {
    await expect(organizationNav).toHaveCount(0);
    await expect(projectNav.getByRole("link")).toHaveText([
      "All projects",
      "Overview",
      "Configuration",
      "Activity",
      "Settings",
    ]);
  });

  await test.step("the back row returns to organization scope", async () => {
    await app.navigation.leaveProject();
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(projectNav).toHaveCount(0);
    await expect(organizationNav).toBeVisible();
  });
});

test("groups organization administration under one Settings entry", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");

  const settingsNav = page.getByRole("navigation", { name: "Organization settings" });

  await test.step("Settings lands on Team and shows the sections it owns", async () => {
    await app.navigation.openOrganizationSection("Settings");
    await expect(page).toHaveURL(/\/o\/[^/]+\/settings\/team$/u);
    // Billing is absent: this instance is not billing-configured.
    await expect(settingsNav.getByRole("link")).toHaveText(["Team", "API keys", "Usage"]);
    await expect(page.getByRole("heading", { name: "Team", exact: true, level: 1 })).toBeVisible();
    await app.navigation.expectBreadcrumb("Acme", "Settings", "Team");
    await page.screenshot({ path: `${SHOTS}/03-settings-team.png`, fullPage: true });
  });

  await test.step("Usage is a settings section, not a top-level destination", async () => {
    await expect(
      page
        .getByRole("navigation", { name: "Organization", exact: true })
        .getByRole("link", { name: "Usage" }),
    ).toHaveCount(0);
    await app.navigation.openOrganizationSettings("Usage");
    await expect(page).toHaveURL(/\/o\/[^/]+\/settings\/usage$/u);
    await expect(page.getByRole("heading", { name: "Usage", exact: true, level: 1 })).toBeVisible();
    // Settings stays lit while any section beneath it is open.
    await expect(
      page
        .getByRole("navigation", { name: "Organization", exact: true })
        .getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("aria-current", "page");
    await page.screenshot({ path: `${SHOTS}/04-settings-usage.png`, fullPage: true });
  });
});

test.describe("instance scope", () => {
  /**
   * The instance is not a tenant: `is_instance_operator` belongs to the user, so no place in the
   * organization → project sidebar would be true. It enters through the account menu, and once
   * entered it is a scope of its own — its own header, its own destinations, its own way back.
   */
  test("enters instance scope from the account menu, from inside a project", async ({
    hub,
    page,
  }) => {
    const app = projectApp(page);
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await hub.grantOperator("owner");

    const instanceNav = page.getByRole("navigation", { name: "Instance", exact: true });

    await test.step("the instance is nowhere in the tenant sidebar", async () => {
      await expect(instanceNav).toHaveCount(0);
      await app.navigation.openProject("Default");
      await expect(instanceNav).toHaveCount(0);
    });

    await test.step("the account menu carries it, because the operator flag is theirs", async () => {
      const menu = await app.navigation.openAccountMenu(owner.email);
      await expect(menu.getByRole("menuitem", { name: "Instance administration" })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/06-account-menu-instance.png`, fullPage: true });
      await page.keyboard.press("Escape");
    });

    await test.step("instance scope replaces the tenant sidebar entirely", async () => {
      await app.navigation.openInstanceSection(owner.email, "Operator");
      await expect(page).toHaveURL(/\/operator$/u);
      await expect(page.getByRole("navigation", { name: "Organization", exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByRole("navigation", { name: "Project", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Organization" })).toHaveCount(0);
      await expect(instanceNav.getByRole("link")).toHaveText(["Back to Acme", "Apps", "Operator"]);
      await app.navigation.expectBreadcrumb("Instance", "Operator");
      // Shoot the loaded page, not its skeletons: the organization picker is the panel's own
      // proof that its data arrived.
      await expect(page.getByRole("combobox", { name: "Manage organization" })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/07-instance-scope.png`, fullPage: true });
    });

    await test.step("the back row names the organization it returns to", async () => {
      await app.navigation.leaveInstance();
      await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
      await expect(instanceNav).toHaveCount(0);
      await expect(
        page.getByRole("navigation", { name: "Organization", exact: true }),
      ).toBeVisible();
    });
  });
});

test("keeps project settings a single page", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.navigation.openProject("Default");
  await app.navigation.openProjectSection("Settings");
  await expect(page).toHaveURL(/\/o\/[^/]+\/projects\/default\/settings$/u);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Project settings" })).toHaveCount(0);
  await app.navigation.expectBreadcrumb("Acme", "Default", "Settings");
  await page.screenshot({ path: `${SHOTS}/05-project-settings.png`, fullPage: true });
});
