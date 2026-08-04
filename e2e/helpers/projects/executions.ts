import { expect, type Page } from "@playwright/test";
export async function expectNoProjectExecutions(page: Page) {
  await expect(page.getByText("No executions", { exact: true })).toBeVisible();
}
export async function expectProjectExecution(page: Page) {
  await expect(thisPageTable(page)).toContainText("succeeded");
}
function thisPageTable(page: Page) {
  return page.getByRole("table", { name: "Project executions" });
}
