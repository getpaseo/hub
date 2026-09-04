import { parseDocument } from "yaml";
import { expect, type Page } from "@playwright/test";

export class OrganizationTriggers {
  constructor(private readonly page: Page) {}

  async open() {
    await this.page.getByRole("link", { name: "Triggers", exact: true }).click();
    await this.page.reload();
    await expect(this.page.getByRole("heading", { name: "Triggers", level: 1 })).toBeVisible();
  }

  async expectEmpty() {
    await expect(this.page.getByText("No triggers", { exact: true })).toBeVisible();
  }

  async startNew() {
    await this.page.getByRole("link", { name: "New trigger" }).click();
    await expect(this.page).toHaveURL(/\/triggers\/new$/u);
    await expect(this.page.getByRole("heading", { name: "New trigger", level: 1 })).toBeVisible();
    await expect(this.page.getByRole("heading", { name: "The event" })).toBeVisible();
    await expect(this.page.getByRole("heading", { name: "Where it runs" })).toBeVisible();
    // The last step keeps its place and says what it is waiting for, so the shape of the
    // trigger is on screen before a daemon is chosen; only its controls are absent.
    await expect(this.page.getByRole("heading", { name: "What runs there" })).toBeVisible();
    await expect(this.page.getByRole("combobox", { name: "Agent" })).toBeHidden();
    await expect(this.page.getByLabel("Working directory")).toBeHidden();
    const topbar = this.page.locator("header.sticky");
    await expect(topbar.getByRole("radio", { name: "Form" })).toBeEnabled();
    await expect(topbar.getByRole("radio", { name: "YAML" })).toBeVisible();
    await expect(topbar.getByRole("button", { name: "Discard" })).toBeVisible();
    await expect(this.page.getByLabel("Trigger ID")).toHaveValue("Assigned when saved");
  }

  async exploreEventQualifiers() {
    await this.page.getByRole("combobox", { name: "When this happens" }).click();
    const search = this.page.getByPlaceholder("Select an event…");
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS("outline-style", "none");
    await this.page.screenshot({ path: "e2e/screenshots/triggers/event-picker.png" });
    await search.fill("pull request created");
    await expect(
      this.page.getByRole("option", {
        name: "GitHub pull request created github.pull_request_created",
        exact: true,
      }),
    ).toBeVisible();
    await this.page.keyboard.press("Escape");
    await this.selectOption("When this happens", "github.pull_request_label_added");
    await expect(this.page.getByRole("radio", { name: "Any label", exact: true })).toBeHidden();
    await expect(this.page.getByLabel("Added label", { exact: true })).toHaveValue("");

    await this.page.getByLabel("Added label", { exact: true }).fill("ready-for-review");
    await this.page.getByLabel("Added label", { exact: true }).scrollIntoViewIfNeeded();
    await this.page.screenshot({ path: "e2e/screenshots/triggers/added-label-qualifier.png" });
    await this.selectOption("When this happens", "github.issue_label_added");
    await expect(this.page.getByLabel("Added label", { exact: true })).toHaveValue(
      "ready-for-review",
    );
    await this.page.screenshot({ path: "e2e/screenshots/triggers/issue-label-qualifier.png" });
    await expect(this.page.getByLabel("Added label", { exact: true })).toHaveAttribute(
      "required",
      "",
    );
    await this.selectOption("When this happens", "slack.mention");
    await expect(this.page.getByLabel("Added label", { exact: true })).toBeHidden();
    await this.selectOption("When this happens", "github.pull_request_label_added");
    await expect(this.page.getByLabel("Added label", { exact: true })).toHaveValue("");
    await expect(this.page.getByRole("radio", { name: "Any label", exact: true })).toBeHidden();
  }

  async configureSlackMention(input: {
    name: string;
    connection: string;
    daemon: string;
    cwd: string;
    users: string;
    agent: string;
    mode: string;
    thinking: string;
    providerOptions: string;
    prompt: string;
  }) {
    await this.page.getByLabel("Trigger name").fill(input.name);
    await this.selectOption("When this happens", "slack.mention");
    // An event that arrives on a connection is an event someone sends, so the step asking who
    // may send it joins the run; a manual run has no audience and no step.
    await expect(this.page.getByRole("heading", { name: "Who can invoke it" })).toBeVisible();
    await this.selectOption("Connection", input.connection);
    await this.page.getByRole("radio", { name: "Specific people" }).click();
    await this.page.getByLabel("User IDs").fill(input.users);
    await this.selectOption("Run on daemon", input.daemon);
    await expect(this.page.getByRole("combobox", { name: "Agent" })).toHaveAttribute(
      "data-value",
      "",
    );
    await expect(this.page.getByRole("combobox", { name: "Execution mode" })).toHaveAttribute(
      "data-value",
      "",
    );
    await this.page.getByLabel("Working directory").fill(input.cwd);
    await this.selectAgent(input.agent);
    await expect(this.page.getByRole("combobox", { name: "Execution mode" })).toHaveAttribute(
      "data-value",
      "",
    );
    await expect(this.page.getByRole("combobox", { name: "Thinking" })).toHaveAttribute(
      "data-value",
      "",
    );
    await this.selectOption("Execution mode", input.mode);
    await this.selectOption("Thinking", input.thinking);
    await this.page.getByRole("button", { name: "Advanced provider options" }).click();
    await this.page.getByLabel("Provider options (JSON)").fill(input.providerOptions);
    await this.page.getByLabel("Instructions", { exact: true }).fill(input.prompt);
  }

  async configureManual(input: {
    name: string;
    daemon: string;
    cwd: string;
    agent: string;
    mode: string;
    thinking: string;
    prompt: string;
  }) {
    await this.page.getByLabel("Trigger name").fill(input.name);
    await this.selectOption("When this happens", "manual.run");
    await this.selectOption("Run on daemon", input.daemon);
    await this.page.getByLabel("Working directory").fill(input.cwd);
    await this.selectAgent(input.agent);
    await this.selectOption("Execution mode", input.mode);
    await this.selectOption("Thinking", input.thinking);
    await this.page.getByLabel("Instructions", { exact: true }).fill(input.prompt);
  }

  async configureLabelAdded(input: { name: string; daemon: string; event: string }) {
    await this.configureManual({
      name: input.name,
      daemon: input.daemon,
      cwd: "/workspace/acme",
      agent: "pi/gateway/vendor/model-v1",
      mode: "full-access",
      thinking: "high",
      prompt: "Handle the labeled item.",
    });
    await this.selectOption("When this happens", input.event);
    await this.page.getByRole("combobox", { name: "Connection", exact: true }).click();
    await this.page.getByRole("option", { name: "acme-inc", exact: true }).click();
  }

  async changeAddedLabel(label: string) {
    await this.page.getByLabel("Added label", { exact: true }).fill(label);
  }

  async expectLabelRequiredOnSubmit() {
    const url = this.page.url();
    await this.page
      .locator("#trigger-editor-form")
      .getByRole("button", { name: /Create trigger|Save changes/u })
      .click();
    await expect(
      this.page.getByRole("alert").filter({ hasText: "This trigger is not ready to save" }),
    ).toContainText("Added label is required.");
    await expect(this.page.getByLabel("Added label", { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(this.page).toHaveURL(url);
  }

  async expectPersistedLabel(event: string, label: string) {
    await this.page.reload();
    await expect(this.page.getByRole("combobox", { name: "When this happens" })).toHaveAttribute(
      "data-value",
      event,
    );
    await expect(this.page.getByLabel("Added label", { exact: true })).toHaveValue(label);
    await this.switchToYaml();
    expect(parseDocument(await this.yamlEditor().innerText()).toJS()).toMatchObject({
      on: { [event]: { filters: { label } } },
    });
    await this.switchToForm();
    await expect(this.page.getByLabel("Added label", { exact: true })).toHaveValue(label);
  }

  async switchToYaml() {
    await this.page.getByRole("radio", { name: "YAML" }).click();
    await expect(this.yamlEditor()).toBeVisible();
  }

  async switchToForm() {
    await this.page.getByRole("radio", { name: "Form" }).click();
    await expect(this.page.getByLabel("Agent", { exact: true })).toBeVisible();
  }

  async replaceYaml(yaml: string) {
    await this.yamlEditor().fill(yaml);
  }

  async save(name: string) {
    await this.page
      .locator("#trigger-editor-form")
      .getByRole("button", { name: /Create trigger|Save changes|Save YAML/u })
      .click();
    await expect(this.page).toHaveURL(/\/triggers$/u);
    await expect(this.page.getByRole("link", { name, exact: true })).toBeVisible();
  }

  async openTrigger(name: string) {
    await this.page.getByRole("link", { name, exact: true }).click();
    await expect(this.page).toHaveURL(/\/triggers\/[^/]+$/u);
    await expect(this.page.getByRole("heading", { name, level: 1 })).toBeVisible();
  }

  async expectFormAgent(input: {
    agent: string;
    mode: string;
    providerOptions: string;
    prompt: string;
  }) {
    await expect(this.page.getByRole("combobox", { name: "Agent" })).toHaveAttribute(
      "data-value",
      input.agent,
    );
    await expect(this.page.getByRole("combobox", { name: "Execution mode" })).toHaveAttribute(
      "data-value",
      input.mode,
    );
    await this.page.getByRole("button", { name: "Advanced provider options" }).click();
    await expect(this.page.getByLabel("Provider options (JSON)")).toHaveValue(
      input.providerOptions,
    );
    await expect(this.page.getByLabel("Instructions", { exact: true })).toHaveValue(input.prompt);
  }

  async expectAgentSearch() {
    const agent = this.page.getByRole("combobox", { name: "Agent" });
    await agent.click();
    const search = this.page.getByPlaceholder("Search models…");
    await expect(search).toBeFocused();
    await search.fill("gpt-5.4");
    await expect(this.page.getByRole("option", { name: /GPT-5.4/u })).toBeVisible();
    await expect(this.page.getByRole("option", { name: /Gateway Model v1/u })).toBeHidden();
    await search.fill("");
  }

  async expectComboboxes() {
    for (const name of [
      "When this happens",
      "Connection",
      "Run on daemon",
      "Agent",
      "Execution mode",
      "Thinking",
    ]) {
      await expect(this.page.getByRole("combobox", { name, exact: true })).toBeVisible();
    }
  }

  async changePrompt(prompt: string) {
    await this.page.getByLabel("Instructions", { exact: true }).fill(prompt);
  }

  async expectMergeTagsAndAutosizing() {
    const instructions = this.page.getByLabel("Instructions", { exact: true });
    await instructions.fill("Start  finish");
    await instructions.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 6));
    await this.page.getByRole("button", { name: "${{ paseo.prompt }}", exact: true }).click();
    await expect(instructions).toHaveValue("Start ${{ paseo.prompt }} finish");
    await instructions.fill(
      Array.from({ length: 24 }, (_, index) => `Line ${index + 1}`).join("\n"),
    );
    const sizing = await instructions.evaluate((element: HTMLTextAreaElement) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(sizing.clientHeight).toBeGreaterThan(300);
    expect(sizing.clientHeight).toBeGreaterThanOrEqual(sizing.scrollHeight - 2);
  }

  async expectYamlContains(...fragments: string[]) {
    for (const fragment of fragments) await expect(this.yamlEditor()).toContainText(fragment);
  }

  async expectLegacyReadOnly() {
    await expect(this.page.getByRole("alert")).toContainText("Legacy multi-step workflow");
    await expect(this.page.getByRole("alert")).toContainText("remains runnable");
    await expect(this.page.getByRole("radio", { name: "Form" })).toBeDisabled();
    await expect(this.yamlEditor()).toHaveAttribute("contenteditable", "false");
    await expect(this.page.getByRole("button", { name: "Save YAML" }).first()).toBeDisabled();
  }

  async expectOperationalList(name: string) {
    const row = this.page.getByRole("row").filter({ hasText: name });
    await expect(row.getByLabel("slack provider")).toBeVisible();
    await expect(row).toContainText("Never");
  }

  /**
   * A disclosure with no brand mark starts its title on the same rail as its own description.
   * The compact header is a grid, and the column a mark would have occupied is still a gap when
   * there is no mark: the title used to sit 12px right of every other line in the card, on
   * phones only, because from `sm` the header is a flex row where an absent mark takes no space.
   */
  async expectDisclosureRailsAtPhoneWidth() {
    const viewport = this.page.viewportSize();
    await this.page.setViewportSize({ width: 420, height: 900 });
    for (const name of ["Advanced provider options", "GitHub access"]) {
      const header = this.page.getByRole("button", { name, exact: false }).first();
      await header.scrollIntoViewIfNeeded();
      const rails = await header.evaluate((element: HTMLElement) =>
        Array.from(element.querySelectorAll("span > span"), (line) =>
          Math.round(line.getBoundingClientRect().left),
        ),
      );
      expect(rails.length).toBeGreaterThan(1);
      expect(new Set(rails).size).toBe(1);
    }
    if (viewport !== null) await this.page.setViewportSize(viewport);
  }

  async capture(path: string) {
    await this.page.screenshot({ path });
  }

  async captureInstructions(path: string) {
    await this.page.getByLabel("Instructions", { exact: true }).scrollIntoViewIfNeeded();
    await this.page.screenshot({ path });
  }

  async captureExpandedAgent(path: string) {
    const agent = this.page.getByRole("combobox", { name: "Agent" });
    await agent.scrollIntoViewIfNeeded();
    await agent.click();
    await expect(this.page.getByPlaceholder("Search models…")).toBeFocused();
    await this.page.screenshot({ path });
  }

  private async selectAgent(agentId: string) {
    await this.page.getByRole("combobox", { name: "Agent" }).click();
    await this.page.locator(`[role="option"][data-value=${JSON.stringify(agentId)}]`).click();
  }

  private async selectOption(label: string, value: string) {
    await this.page.getByRole("combobox", { name: label, exact: true }).click();
    await this.page.locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
  }

  private yamlEditor() {
    return this.page.getByRole("textbox", { name: "Trigger YAML" });
  }
}
