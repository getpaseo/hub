import { expect, type Page } from "@playwright/test";

export class ProjectLifecycle {
  constructor(private readonly page: Page) {}

  async expectDefaultProject() {
    await expect(this.page.getByRole("link", { name: "Default" })).toBeVisible();
  }

  async create(name: string, slug: string) {
    await this.page.getByRole("button", { name: "New project" }).click();
    const form = this.page.getByRole("form", { name: "Create project" });
    await form.getByLabel("Project name").fill(name);
    await form.getByLabel("Project slug").fill(slug);
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(this.page.getByRole("link", { name })).toBeVisible();
  }

  async archive(name: string) {
    await this.page.getByRole("button", { name: `Archive ${name}` }).click();
    await this.page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Archive project" })
      .click();
    await expect(this.page.getByRole("row", { name: new RegExp(name, "u") })).toContainText(
      "Archived",
    );
  }
}
