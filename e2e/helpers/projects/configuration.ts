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

  async switchToGitHub() {
    await this.page.getByRole("radio", { name: "GitHub" }).click();
  }

  /**
   * The source controls live in the editor's fixed left rail. A control wider
   * than the rail runs under the document pane instead of being reachable.
   */
  async expectSourceControlsClearOfTheEditor() {
    const picker = await this.page.getByRole("combobox").boundingBox();
    const document = await this.editor().boundingBox();
    if (picker === null || document === null) throw new Error("source controls are not rendered");
    expect(picker.x + picker.width).toBeLessThanOrEqual(document.x);
  }

  /** The open document. CodeMirror exposes its content as a textbox labelled by path. */
  private editor(label = "Configuration YAML") {
    return this.page.getByRole("textbox", { name: label });
  }

  private partialLabel(path: string) {
    return path.startsWith(".paseo/workflows/partials/")
      ? path
      : `.paseo/workflows/partials/${path}`;
  }

  private async startEditing() {
    const editing = this.page.getByText("Editing");
    const edit = this.page.getByRole("button", { name: "Edit", exact: true });
    const save = this.page.getByRole("button", { name: "Save and activate" });
    // Switching the source to manual refetches the snapshot; neither control is on
    // the page until it lands. A caller may also follow a successful activation
    // immediately; wait for that pending save to settle before opening another
    // edit, because activation remounts the workbench on the new revision.
    await expect(edit.or(editing).first()).toBeVisible();
    await expect
      .poll(
        async () =>
          (await edit.isVisible()) ||
          ((await editing.isVisible()) && (await save.getAttribute("aria-busy")) !== "true"),
      )
      .toBe(true);
    if (await edit.isVisible()) await edit.click();
    await expect(editing).toBeVisible();
  }

  async saveManualConfiguration(rawYaml: string) {
    await this.startEditing();
    await this.editor().fill(rawYaml);
    await this.page.getByRole("button", { name: "Save and activate" }).click();
  }

  /** Activate the open documents exactly as they are — the preserved switch-to-manual bundle. */
  async saveUnmodified() {
    await this.startEditing();
    await this.save();
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

  async addWorkflow(name: string, content: string) {
    await this.startEditing();
    await this.page.getByRole("button", { name: "Add workflow" }).click();
    await this.page.getByLabel("Workflow file name").fill(name);
    await this.page.getByRole("button", { name: "Add", exact: true }).click();
    await this.editor().fill(content);
  }

  async removePartial(path: string) {
    await this.startEditing();
    await this.page.getByRole("button", { name: `Remove ${path}` }).click();
  }

  async removeWorkflow(path: string) {
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

  /** A rendered document line. CodeMirror gives lines no role of their own. */
  private line(text: string) {
    return this.page.locator(".cm-line").filter({ hasText: text });
  }

  /** Reach the end of a long document the way an operator does: wheel over it. */
  async scrollEditorToEnd() {
    await this.editor().hover();
    for (let tick = 0; tick < 20; tick += 1) await this.page.mouse.wheel(0, 600);
  }

  async expectLineOutOfSight(text: string) {
    await expect(this.line(text)).not.toBeInViewport();
  }

  async expectLineInSight(text: string) {
    await expect(this.line(text)).toBeInViewport();
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
