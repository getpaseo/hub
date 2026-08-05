import { expect, type Page } from "@playwright/test";
export async function expectNoProjectActivity(page: Page) {
  await expect(page.getByText("No activity", { exact: true })).toBeVisible();
}
export async function expectProjectActivity(page: Page) {
  await expect(page.getByRole("table", { name: "Project activity" })).toContainText("Manual run");
}
