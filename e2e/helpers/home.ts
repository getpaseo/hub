import { expect, type Locator, type Page } from "@playwright/test";

export type ChecklistStepTitle =
  | "Connect an app"
  | "Connect a daemon"
  | "Create a trigger"
  | "Run it";

/**
 * The organization landing: the checklist and the overview under it. Rows are addressed by the
 * step's title, and a step's state is the pill beside it, so the DSL reads like the page does.
 */
export class OrganizationHome {
  constructor(private readonly page: Page) {}

  async open() {
    await this.page.getByRole("link", { name: "Home", exact: true }).click();
    await this.expectOpen();
  }

  async expectOpen() {
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/home$/u);
    await expect(this.page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  }

  async reload() {
    await this.page.reload();
    await this.expectOpen();
  }

  step(title: ChecklistStepTitle): Locator {
    return this.page
      .getByRole("list", { name: "Get started" })
      .getByRole("listitem")
      .filter({ hasText: title });
  }

  async expectStep(title: ChecklistStepTitle, state: string) {
    await expect(this.step(title)).toContainText(state);
  }

  async expectProgress(progress: string) {
    await expect(this.page.getByRole("button", { name: /Get started/u })).toContainText(progress);
  }

  /** The list is hidden once every step is done; the header stays, and a click brings it back. */
  async expectCollapsed() {
    await expect(this.page.getByRole("list", { name: "Get started" })).toBeHidden();
  }

  async toggle() {
    await this.page.getByRole("button", { name: /Get started/u }).click();
  }

  async expectExpanded() {
    await expect(this.page.getByRole("list", { name: "Get started" })).toBeVisible();
  }

  /** The command a row tells the reader to run, as rendered. */
  command(title: ChecklistStepTitle): Locator {
    return this.step(title).locator("span.font-mono");
  }

  async followStepAction(title: ChecklistStepTitle, name: string) {
    await this.step(title).getByRole("link", { name, exact: true }).click();
  }

  nudge(): Locator {
    return this.page
      .getByRole("alert")
      .filter({ hasText: "Events are arriving with no trigger listening" });
  }

  async expectNoNudge() {
    await expect(this.nudge()).toHaveCount(0);
  }

  async followNudge() {
    await this.nudge().getByRole("link", { name: "Create a trigger", exact: true }).click();
    await expect(this.page).toHaveURL(/\/triggers\/new$/u);
  }

  async expectRuns(count: number, outcomes: string) {
    const tile = this.page.getByText("Runs", { exact: true }).locator("..").locator("..");
    await expect(tile).toContainText(String(count));
    await expect(tile).toContainText(outcomes);
  }

  async expectRecentRun(triggerName: string, status: string) {
    const row = this.page
      .getByRole("list", { name: "Recent runs" })
      .getByRole("listitem")
      .filter({ hasText: triggerName });
    await expect(row).toContainText(status);
  }

  async capture(path: string) {
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.screenshot({ path, fullPage: true });
  }
}
