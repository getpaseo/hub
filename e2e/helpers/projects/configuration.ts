import { expect, type Page } from "@playwright/test";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export class ProjectConfiguration {
  constructor(private readonly page: Page) {}

  async useRepository(fullName: string) {
    await this.page.getByRole("link", { name: "Configuration" }).click();
    const githubMode = this.page.getByRole("radio", { name: "GitHub" });
    if ((await githubMode.getAttribute("aria-checked")) !== "true") await githubMode.click();
    await this.page.getByRole("combobox").click();
    await this.page.getByRole("option", { name: new RegExp(escapeRegExp(fullName)) }).click();
    await this.page.getByRole("button", { name: "Save" }).click();
    await expect(this.page.getByRole("combobox")).toHaveText(fullName);
  }

  async switchToManual() {
    await this.page.getByRole("radio", { name: "Manual" }).click();
  }

  async saveManualConfiguration(rawYaml: string) {
    const textarea = this.page.getByLabel("Configuration YAML");
    await textarea.fill(rawYaml);
    await this.page.getByRole("button", { name: "Save and activate" }).click();
  }

  async expectActiveRevision(version: number) {
    await this.page
      .getByRole("navigation", { name: "Project" })
      .getByRole("link", { name: "Configuration" })
      .click();
    await expect(this.page.getByText(`Revision ${version}`, { exact: true })).toBeVisible();
  }

  async syncNow() {
    await this.page.getByRole("button", { name: "Sync now" }).click();
  }

  async expectInvalidPreserved(version: number) {
    await expect(this.page.getByText(`Revision ${version}`, { exact: true })).toBeVisible();
    await expect(this.page.getByRole("status")).toContainText(
      "Invalid revision; active revision preserved",
    );
  }
}
