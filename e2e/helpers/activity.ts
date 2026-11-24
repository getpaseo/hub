import { expect, type Locator, type Page } from "@playwright/test";

export type ActivityView = "Runs" | "Unmatched events";
export type ActivityFilter = "Range" | "Source" | "Status" | "Trigger" | "Daemon" | "Reason";

/**
 * The organization's Activity screen: one list of runs or of unmatched events, the filters
 * above it, and the record open beside it. Every control writes the URL, so the DSL reads the
 * URL back where a reader would share or reload it.
 */
export class OrganizationActivity {
  constructor(private readonly page: Page) {}

  async open() {
    await this.page.getByRole("link", { name: "Activity", exact: true }).click();
    await this.expectOpen();
  }

  async expectOpen() {
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/activity(\?.*)?$/u);
    await expect(this.page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  }

  /** The same address again. An open record covers the page, so only the URL is checked here. */
  async reload() {
    const url = this.page.url();
    await this.page.reload();
    await expect(this.page).toHaveURL(url);
  }

  async show(view: ActivityView) {
    await this.page
      .getByRole("radiogroup", { name: "Show" })
      .getByRole("radio", { name: view })
      .click();
    await expect(this.table(view)).toBeVisible();
  }

  table(view: ActivityView): Locator {
    return this.page.getByRole("table", { name: view });
  }

  /** Body rows only: the header row has no cells. */
  rows(view: ActivityView): Locator {
    return this.table(view)
      .getByRole("row")
      .filter({ has: this.page.getByRole("cell") });
  }

  row(view: ActivityView, text: string): Locator {
    return this.rows(view).filter({ hasText: text });
  }

  async expectRows(view: ActivityView, count: number) {
    await expect(this.rows(view)).toHaveCount(count);
  }

  /** The footer's "first–last of total" line. */
  async expectPageRange(view: ActivityView, range: string) {
    await expect(this.page.getByRole("navigation", { name: `${view} pages` })).toContainText(range);
  }

  async nextPage(view: ActivityView) {
    await this.page
      .getByRole("navigation", { name: `${view} pages` })
      .getByRole("button", { name: "Next page" })
      .click();
  }

  async previousPage(view: ActivityView) {
    await this.page
      .getByRole("navigation", { name: `${view} pages` })
      .getByRole("button", { name: "Previous page" })
      .click();
  }

  async filter(filter: ActivityFilter, option: string) {
    await this.page.getByRole("combobox", { name: filter }).click();
    await this.page.getByRole("option", { name: option, exact: true }).click();
    await expect(this.page.getByRole("combobox", { name: filter })).toContainText(option);
  }

  async search(label: "Search runs" | "Search events", text: string) {
    const box = this.page.getByRole("searchbox", { name: label });
    await box.fill(text);
    await box.press("Enter");
  }

  async clearFilters() {
    await this.page
      .getByRole("group", { name: "Filters" })
      .getByRole("button", { name: "Clear filters" })
      .click();
  }

  async sortBy(view: ActivityView, column: string) {
    await this.table(view).getByRole("columnheader", { name: column }).getByRole("button").click();
  }

  async expectSorted(view: ActivityView, column: string, order: "ascending" | "descending") {
    await expect(this.table(view).getByRole("columnheader", { name: column })).toHaveAttribute(
      "aria-sort",
      order,
    );
  }

  async expectUrl(params: Record<string, string | null>) {
    await expect
      .poll(() => {
        const url = new URL(this.page.url());
        return Object.fromEntries(
          Object.keys(params).map((key) => [key, url.searchParams.get(key)]),
        );
      })
      .toEqual(params);
  }

  async openRecord(view: ActivityView, text: string) {
    await this.row(view, text).first().getByRole("link").first().click();
  }

  async openFirstRecord(view: ActivityView) {
    await this.rows(view).first().getByRole("link").first().click();
  }

  record(): Locator {
    return this.page.getByRole("dialog");
  }

  async expectRecord(title: string) {
    await expect(this.record().getByRole("heading", { name: title })).toBeVisible();
  }

  async expectNoRecord() {
    await expect(this.record()).toHaveCount(0);
  }

  async stepRecord(direction: "Previous record" | "Next record") {
    await this.record().getByRole("button", { name: direction }).click();
  }

  async closeRecordWithEscape() {
    await this.page.keyboard.press("Escape");
    await this.expectNoRecord();
  }

  async capture(path: string) {
    await this.page.screenshot({ path });
  }
}
