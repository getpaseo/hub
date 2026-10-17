import { expect, type Page } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

test("follows the system, remembers an override, and returns to automatic appearance", async ({
  hub,
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await hub.visitHome();
  await expectTheme(page, "dark");

  await chooseTheme(page, "Light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "light");
  await page.reload();
  await expectTheme(page, "light");

  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const light = page.getByRole("radio", { name: "Light", exact: true });
  await expect(light).toBeChecked();
  await light.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  await expectTheme(page, "dark");
  await page.keyboard.press("Escape");

  await chooseTheme(page, "System");
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "dark");
});

test("shares appearance across tabs and keeps the API reference in sync", async ({
  hub,
  page,
  context,
}) => {
  await hub.visitHome();
  const reference = await context.newPage();
  await reference.goto(`${hub.primaryApplication().origin}/api/reference`);
  await expect(reference.getByRole("button", { name: /^Configurations /u })).toBeVisible();

  for (const theme of ["Light", "Dark"] as const) {
    await chooseTheme(page, theme);
    const resolved = theme === "Light" ? "light" : "dark";
    await expectTheme(reference, resolved);
    await expect(reference.locator("body")).toHaveClass(new RegExp(`${resolved}-mode`, "u"));
  }
});

test("keeps appearance usable when browser storage is blocked", async ({ hub, page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage is disabled", "SecurityError");
      },
    });
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await hub.visitHome();
  await expectTheme(page, "dark");
  await chooseTheme(page, "Light");
  await expectTheme(page, "light");
  await chooseTheme(page, "System");
  await expectTheme(page, "dark");
});

for (const theme of ["light", "dark"] as const) {
  test(`applies saved ${theme} appearance before application scripts load`, async ({
    hub,
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme === "light" ? "dark" : "light" });
    await page.addInitScript((preference) => {
      localStorage.setItem("paseo-hub-theme", preference);
    }, theme);
    await page.route(/\.js(?:\?|$)/u, (route) => route.abort());
    await hub.visitHome();
    await expectTheme(page, theme);
  });
}

test("keeps the chosen appearance through sign in, dashboard navigation, and the code editor", async ({
  hub,
  page,
}) => {
  await hub.visitHome();
  await chooseTheme(page, "Light");
  await hub.signUpAs("owner", {
    name: "Theme Owner",
    email: "theme-owner@example.com",
    password: "theme-owner-password",
  });
  await hub.createOrganization("owner", "Theme workspace");
  const daemon = await hub.connectProviderDaemon("owner", "Theme workspace");
  await expectTheme(page, "light");
  await expect(page.getByRole("button", { name: "Appearance", exact: true })).toBeVisible();

  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  await triggers.startNew();
  await triggers.configureManual({
    name: "theme-preview",
    daemon,
    cwd: "/workspace",
    agent: "opencode/gateway/vendor/model-v1",
    mode: "full-access",
    thinking: "low",
    prompt: "Summarize the changes.",
  });
  await page.getByRole("radio", { name: "YAML", exact: true }).click();
  const editor = page.getByTestId("code-editor");
  await expect(editor).toHaveCSS("color", "rgb(40, 42, 48)");
  await chooseTheme(page, "Dark");
  await expectTheme(page, "dark");
  await expect(editor).toHaveCSS("color", "rgb(247, 248, 248)");
});

async function chooseTheme(page: Page, theme: "System" | "Light" | "Dark"): Promise<void> {
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: theme, exact: true }).click();
  await page.keyboard.press("Escape");
}

async function expectTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    theme === "light" ? "rgb(255, 255, 255)" : "rgb(8, 9, 10)",
  );
}
