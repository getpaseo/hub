import { expect, type Locator, type Page } from "@playwright/test";
import { holdPageData } from "./pending-navigation.js";

export type ActivityView = "Runs" | "Unmatched events";
export type ActivityFilter = "Range" | "Provider" | "Status" | "Trigger" | "Daemon" | "Reason";

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

  /**
   * Switching views while the new list is still loading leaves nothing of the previous view to
   * click: a run's id opened as an unmatched event would find no record.
   */
  async showWhileTheListLoads(view: ActivityView, previous: ActivityView) {
    const data = await holdPageData(this.page);
    await this.page
      .getByRole("radiogroup", { name: "Show" })
      .getByRole("radio", { name: view })
      .click();
    await data.requested;
    await expect(this.table(previous)).toHaveCount(0);
    await data.release();
    await expect(this.table(view)).toBeVisible();
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

  async expectLastPage(view: ActivityView) {
    await expect(
      this.page
        .getByRole("navigation", { name: `${view} pages` })
        .getByRole("button", { name: "Next page" }),
    ).toBeDisabled();
  }

  /** The same view at another page, the way a stale bookmark or shared link reaches it. */
  async visitPage(page: number) {
    const url = new URL(this.page.url());
    url.searchParams.set("page", String(page));
    await this.page.goto(url.href);
  }

  /** A page past the last offers the way back to the first instead of an empty table. */
  async returnToFirstPage(message: string) {
    await expect(this.page.getByText(message, { exact: true })).toBeVisible();
    await this.page.getByRole("button", { name: "First page", exact: true }).click();
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

  /** Open in Paseo goes to the agent itself, not through Hub's page for links shared elsewhere. */
  async expectOpensInPaseo(deepLink: string) {
    await expect(this.record().getByRole("link", { name: "Open in Paseo" })).toHaveAttribute(
      "href",
      deepLink,
    );
  }

  /** The note that says where Paseo keeps an agent its sidebar does not list. */
  async expectAgentVisibilityNote(text: string) {
    await expect(
      this.record().getByRole("status").filter({ hasText: "Where to find this agent" }),
    ).toContainText(text);
  }

  async expectNoRecord() {
    await expect(this.record()).toHaveCount(0);
  }

  async stepRecord(direction: "Previous record" | "Next record") {
    await this.record().getByRole("button", { name: direction }).click();
  }

  /** Copy link puts the address of the view as it stands now on the clipboard. */
  async expectCopiedLinkIsThisView() {
    await this.page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(this.page.url()).origin,
    });
    await this.record().getByRole("button", { name: "Copy link" }).click();
    await expect(this.record().getByRole("status").filter({ hasText: "Copied link" })).toHaveCount(
      1,
    );
    await expect
      .poll(() => this.page.evaluate(() => navigator.clipboard.readText()))
      .toBe(this.page.url());
  }

  /** A browser that refuses the clipboard leaves the reader the address bar to copy from. */
  async expectCopyLinkFallbackWhenClipboardIsBlocked() {
    await this.page.evaluate(() => {
      navigator.clipboard.writeText = () =>
        Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"));
    });
    await this.record().getByRole("button", { name: "Copy link" }).click();
    await expect(this.record()).toContainText("Copy the address from the browser");
  }

  async closeRecordWithEscape() {
    await this.page.keyboard.press("Escape");
    await this.expectNoRecord();
  }

  async capture(path: string) {
    await this.page.screenshot({ path });
  }
}
