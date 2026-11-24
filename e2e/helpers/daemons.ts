import { expect, type Page } from "@playwright/test";

export class OrganizationDaemons {
  constructor(private readonly page: Page) {}

  async open() {
    await this.page.getByRole("link", { name: "Daemons", exact: true }).click();
    await expect(this.page.getByRole("heading", { name: "Daemons", level: 1 })).toBeVisible();
  }

  /** A daemon's row actions open Activity on the runs it executed. */
  async openActivity(slug: string) {
    await this.page.getByRole("button", { name: `Actions for ${slug}` }).click();
    await this.page.getByRole("menuitem", { name: "View activity" }).click();
  }
}
