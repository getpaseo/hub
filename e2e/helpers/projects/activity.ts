import { expect, type Page } from "@playwright/test";
export async function expectNoProjectActivity(page: Page) {
  await expect(page.getByText("No activity", { exact: true })).toBeVisible();
}
export async function expectProjectActivity(page: Page) {
  await expect(page.getByRole("table", { name: "Project activity" })).toContainText("Manual run");
}

export async function openProjectRun(page: Page, triggerName: string) {
  await page
    .getByRole("table", { name: "Project activity" })
    .getByRole("link", { name: triggerName, exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Run detail" })).toBeVisible();
}

export async function expectRunDetail(
  page: Page,
  input: { rawMessage: string; cleanPrompt: string; failureReason?: string },
) {
  await expect(page.getByText("Raw message", { exact: true })).toBeVisible();
  await expect(page.getByText(input.rawMessage, { exact: true })).toBeVisible();
  await expect(page.getByText("Clean prompt", { exact: true })).toBeVisible();
  await expect(page.getByText(input.cleanPrompt, { exact: true })).toBeVisible();
  await expect(page.getByText("Typed inputs", { exact: true })).toBeVisible();
  await expect(page.getByText("Composed routing values", { exact: true })).toBeVisible();
  if (input.failureReason !== undefined) {
    await expect(page.getByText(input.failureReason, { exact: false })).toBeVisible();
  }
}

export async function expectRunSteps(page: Page, steps: readonly string[]) {
  const table = page.getByRole("table", { name: "Run steps" });
  await expect(table).toBeVisible();
  for (const step of steps) await expect(table).toContainText(step);
}
