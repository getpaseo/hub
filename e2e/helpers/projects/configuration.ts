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
    await this.page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(this.page.getByRole("combobox")).toHaveText(fullName);
  }

  async switchToManual() {
    await this.page.getByRole("radio", { name: "Manual" }).click();
  }

  /** The open document. CodeMirror exposes its content as a textbox labelled by path. */
  private editor(label = "Configuration YAML") {
    return this.page.getByRole("textbox", { name: label });
  }

  private partialLabel(path: string) {
    return `.paseo/partials/${path}`;
  }

  private async startEditing() {
    const editing = this.page.getByText("Editing");
    const edit = this.page.getByRole("button", { name: "Edit", exact: true });
    // Switching the source to manual refetches the snapshot; neither control is on
    // the page until it lands.
    await expect(edit.or(editing).first()).toBeVisible();
    if (await edit.isVisible()) await edit.click();
    await expect(editing).toBeVisible();
  }

  async saveManualConfiguration(rawYaml: string) {
    await this.startEditing();
    await this.editor().fill(rawYaml);
    await this.page.getByRole("button", { name: "Save and activate" }).click();
  }

  async save() {
    await this.page.getByRole("button", { name: "Save and activate" }).click();
  }

  async openFile(name: string) {
    await this.page
      .getByRole("list", { name: "Configuration files" })
      .getByRole("button", { name, exact: true })
      .click();
  }

  async addPartial(path: string, content: string) {
    await this.startEditing();
    await this.page.getByRole("button", { name: "Add partial" }).click();
    await this.page.getByLabel("Partial path").fill(path);
    await this.page.getByRole("button", { name: "Add", exact: true }).click();
    await this.editor(this.partialLabel(path)).fill(content);
  }

  async removePartial(path: string) {
    await this.startEditing();
    await this.page.getByRole("button", { name: `Remove ${path}` }).click();
  }

  async expectReadOnlyEditor(yaml: string) {
    await expect(this.page.getByText("Read-only")).toBeVisible();
    await expect(this.editor()).toHaveAttribute("contenteditable", "false");
    await expect(this.editor()).toContainText(yaml);
  }

  async expectFiles(names: string[]) {
    await expect(
      this.page.getByRole("list", { name: "Configuration files" }).getByRole("button"),
    ).toHaveText(names);
  }

  async expectPartialContent(path: string, content: string) {
    await this.openFile(path);
    await expect(this.editor(this.partialLabel(path))).toContainText(content);
  }

  async expectHighlightedYaml() {
    await expect(this.page.locator(".cm-line span").first()).toBeVisible();
  }

  async expectValidationError(message: string) {
    await expect(this.page.getByRole("alert")).toContainText(message);
  }

  async expectConfigurationActivated(version: number) {
    await expect(this.page.getByRole("status")).toHaveText(
      `Configuration saved and activated as Revision ${String(version)}.`,
    );
  }

  async expectActiveRevision(version: number) {
    await this.page
      .getByRole("navigation", { name: "Project" })
      .getByRole("link", { name: "Configuration" })
      .click();
    await expect(this.page.getByText(`Revision ${version}`, { exact: true })).toBeVisible();
  }

  async expectNoPriorProjectFeedback(version: number, validationResource: string) {
    await expect(this.page.getByRole("status")).toHaveText("No active configuration.");
    await expect(this.page.getByRole("alert")).toHaveCount(0);
    await expect(this.page.getByText(`Revision ${String(version)}`, { exact: true })).toHaveCount(
      0,
    );
    await expect(this.page.getByText(validationResource)).toHaveCount(0);
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
