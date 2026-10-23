import { expect, type Page } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

test.beforeEach(async ({ hub, page }) => {
  await hub.signUpAs("owner", {
    name: "Status Owner",
    email: "status-owner@example.com",
    password: "status-owner-password",
  });
  await hub.createOrganization("owner", "Status filters");
  for (const name of ["enabled-trigger", "disabled-trigger"]) {
    await hub.seedLegacyTrigger("owner", name, `name: ${name}\non: manual.run\nsteps: []\n`);
  }
  await hub
    .primaryApplication()
    .query("update organization_triggers set enabled = false where name = $1", [
      "disabled-trigger",
    ]);
  await new OrganizationTriggers(page).open();
});

test("filters Status and remembers the selection across reloads, navigation, and tabs", async ({
  page,
  context,
}) => {
  await expect(statusOption(page, "All")).toBeChecked();
  await expectRows(page, true, true);
  await statusOption(page, "Enabled").click();
  await expectRows(page, true, false);
  await statusOption(page, "Disabled").click();
  await expectRows(page, false, true);

  await page.reload();
  await expect(statusOption(page, "Disabled")).toBeChecked();
  await expectRows(page, false, true);
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await expect(statusOption(page, "Disabled")).toBeChecked();
  await expectRows(page, false, true);

  const other = await context.newPage();
  await other.goto(page.url());
  await expect(statusOption(other, "Disabled")).toBeChecked();
  await expectRows(other, false, true);
  await statusOption(page, "All").click();
  await expect(statusOption(other, "All")).toBeChecked();
  await expectRows(other, true, true);
  await statusOption(page, "All").press("ArrowRight");
  await expect(statusOption(page, "Enabled")).toBeChecked();
  await expectRows(page, true, false);
});

test("keeps each organization's remembered status separate", async ({ page }) => {
  await statusOption(page, "Disabled").click();
  const first = page.url();
  await page.getByRole("button", { name: "Organization", exact: true }).click();
  await page.getByRole("menuitem", { name: "New organization", exact: true }).click();
  const form = page.getByRole("form", { name: "Create organization" });
  await form.getByLabel("Organization name").fill("Other filters");
  await form.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page).toHaveURL(/\/o\/[^/]+\/home$/u);
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await expect(statusOption(page, "All")).toBeChecked();
  await expect(page.getByText("No triggers", { exact: true })).toBeVisible();
  await statusOption(page, "Enabled").click();
  const second = page.url();

  await page.goto(first);
  await expect(statusOption(page, "Disabled")).toBeChecked();
  await expectRows(page, false, true);
  await page.goto(second);
  await expect(statusOption(page, "Enabled")).toBeChecked();
});

test("handles invalid saved values and keeps filtering when storage is blocked", async ({
  page,
}) => {
  await statusOption(page, "Enabled").click();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((value) =>
      value.startsWith("paseo-hub-trigger-status:"),
    );
    if (key === undefined) throw new Error("Status preference was not saved");
    localStorage.setItem(key, "unknown-status");
  });
  await page.reload();
  await expect(statusOption(page, "All")).toBeChecked();
  await expectRows(page, true, true);

  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage is disabled", "SecurityError");
      },
    });
  });
  await page.reload();
  await statusOption(page, "Disabled").click();
  await expect(statusOption(page, "Disabled")).toBeChecked();
  await expectRows(page, false, true);
});

test("shows a status-specific empty state and lets All restore the table", async ({
  hub,
  page,
}) => {
  await hub.primaryApplication().query("update organization_triggers set enabled = true");
  await page.reload();
  await statusOption(page, "Disabled").click();
  await expect(page.getByText("No disabled triggers", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Triggers", exact: true })).toBeHidden();
  await statusOption(page, "All").click();
  await expectRows(page, true, true);

  await hub.primaryApplication().query("update organization_triggers set enabled = false");
  await page.reload();
  await statusOption(page, "Enabled").click();
  await expect(page.getByText("No enabled triggers", { exact: true })).toBeVisible();
  await statusOption(page, "All").click();
  await expectRows(page, true, true);
});

function statusOption(page: Page, name: "All" | "Enabled" | "Disabled") {
  return page
    .getByRole("radiogroup", { name: "Trigger status" })
    .getByRole("radio", { name, exact: true });
}

async function expectRows(page: Page, enabled: boolean, disabled: boolean): Promise<void> {
  const table = page.getByRole("table", { name: "Triggers", exact: true });
  await expect(table.getByRole("row")).toHaveCount(1 + Number(enabled) + Number(disabled));
  for (const [name, visible] of [
    ["enabled-trigger", enabled],
    ["disabled-trigger", disabled],
  ] as const) {
    const row = table.getByRole("link", { name, exact: true });
    if (visible) await expect(row).toBeVisible();
    else await expect(row).toBeHidden();
  }
}
