import { expect, type Page } from "@playwright/test";
import { test } from "./app.js";
import type { PaseoHub } from "./helpers/hub.js";
import { projectApp } from "./helpers/projects/index.js";
import { holdPageScripts, holdPageData } from "./helpers/pending-navigation.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const owner = {
  name: "Alice",
  email: "alice-navigation-pending@example.com",
  password: "alice-navigation-pending-password",
};

test("keeps shell and body together through a slow download and cached navigation", async ({
  hub,
  page,
}) => {
  await openOrganization(hub, page);
  const download = await holdPageScripts(page);
  try {
    await projectApp(page).navigation.openOrganizationSection("Daemons");
    await download.requested;
    await expectOrganizationPage(page, "Triggers");
    await download.showPendingPage();
    await expectOrganizationDestination(page, "Daemons");
    await expect(page.getByRole("heading", { name: "Triggers", exact: true })).toBeHidden();
  } finally {
    await download.release();
  }
  await expectOrganizationPage(page, "Daemons");
  await projectApp(page).navigation.openOrganizationSection("Triggers");
  await expectOrganizationPage(page, "Triggers");
  await projectApp(page).navigation.openOrganizationSection("Daemons");
  await expectOrganizationPage(page, "Daemons");
  await page.goBack();
  await expectOrganizationPage(page, "Triggers");
});

test("a later navigation wins while an earlier download is pending", async ({ hub, page }) => {
  await openOrganization(hub, page);
  const download = await holdPageScripts(page);
  try {
    await projectApp(page).navigation.openOrganizationSection("Daemons");
    await download.requested;
    await download.showPendingPage();
    await projectApp(page).navigation.openOrganizationSection("Triggers");
    await expectOrganizationPage(page, "Triggers");
  } finally {
    await download.release();
  }
  await expectOrganizationPage(page, "Triggers");
  await expect(page.getByRole("heading", { name: "Daemons", exact: true })).toBeHidden();
});

test("keeps settings tabs aligned through pending navigation and Back", async ({ hub, page }) => {
  await openOrganization(hub, page);
  await projectApp(page).navigation.openOrganizationSection("Settings");
  await expectSettingsPage(page, "Team");
  const download = await holdPageScripts(page);
  try {
    await openSettingsTab(page, "Usage");
    await download.requested;
    await expectSettingsPage(page, "Team");
    await download.showPendingPage();
    await expectSettingsDestination(page, "Usage");
    await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeHidden();
    await page.goBack();
    await expectSettingsPage(page, "Team");
  } finally {
    await download.release();
  }
  await expectSettingsPage(page, "Team");
});

test("switches organization and instance context with the presented page", async ({
  hub,
  page,
}) => {
  await openOrganization(hub, page);
  await hub.grantOperator("owner");
  await expectOrganizationPage(page, "Triggers");
  const download = await holdPageScripts(page);
  try {
    await enterInstance(page);
    await download.requested;
    await expectOrganizationPage(page, "Triggers");
    await download.showPendingPage();
    await projectApp(page).navigation.expectBreadcrumb("Instance", "Apps");
    await expect(page.getByRole("navigation", { name: "Instance", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Triggers", exact: true })).toBeHidden();
  } finally {
    await download.release();
  }
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await projectApp(page).navigation.leaveInstance();
  await expectOrganizationPage(page, "Triggers");
});

test("removes the previous page's header actions when its replacement is presented", async ({
  hub,
  page,
}) => {
  await openOrganization(hub, page);
  await new OrganizationTriggers(page).startNew();
  const download = await holdPageScripts(page);
  try {
    await projectApp(page).navigation.openOrganizationSection("Daemons");
    await download.requested;
    await projectApp(page).navigation.expectBreadcrumb("Acme", "Triggers", "Trigger editor");
    await expect(page.getByRole("radio", { name: "Form", exact: true })).toBeVisible();
    await download.showPendingPage();
    await expectOrganizationDestination(page, "Daemons");
    await expect(page.getByRole("radio", { name: "Form", exact: true })).toBeHidden();
  } finally {
    await download.release();
  }
  await expectOrganizationPage(page, "Daemons");
});

test("replaces the old body while destination data is delayed", async ({ hub, page }) => {
  await openOrganization(hub, page);
  const data = await holdPageData(page);
  try {
    await projectApp(page).navigation.openOrganizationSection("Daemons");
    await data.requested;
    await expectOrganizationPage(page, "Daemons");
    await expect(page.getByRole("heading", { name: "Triggers", exact: true })).toBeHidden();
  } finally {
    await data.release();
  }
  await expectOrganizationPage(page, "Daemons");
});

async function openOrganization(hub: PaseoHub, page: Page) {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await expectOrganizationPage(page, "Triggers");
}

async function expectOrganizationDestination(page: Page, name: string) {
  await projectApp(page).navigation.expectBreadcrumb("Acme", name);
  await expect(
    page
      .getByRole("navigation", { name: "Organization", exact: true })
      .getByRole("link", { name, exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Organization", exact: true })).toContainText(
    "Acme",
  );
}

async function expectOrganizationPage(page: Page, name: string) {
  await expectOrganizationDestination(page, name);
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Loading page", exact: true })).toBeHidden();
}

async function openSettingsTab(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Organization settings" })
    .getByRole("link", { name, exact: true })
    .click();
}

async function expectSettingsDestination(page: Page, name: string) {
  await projectApp(page).navigation.expectBreadcrumb("Acme", "Settings", name);
  await expect(
    page
      .getByRole("navigation", { name: "Organization settings" })
      .getByRole("link", { name, exact: true }),
  ).toHaveAttribute("aria-current", "page");
}

async function expectSettingsPage(page: Page, name: string) {
  await expectSettingsDestination(page, name);
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
}

async function enterInstance(page: Page) {
  const menu = await projectApp(page).navigation.openAccountMenu(owner.email);
  await menu.getByRole("menuitem", { name: "Instance administration" }).click();
}
