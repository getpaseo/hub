import { parseDocument } from "yaml";
import { expect, type Page } from "@playwright/test";
import { allowClipboard } from "./apps.js";
import type { BuiltApplication } from "./hub.js";

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
    // Every step keeps its place and says what it is waiting for, so the shape of the trigger
    // is on screen before a daemon is chosen; only the controls of the later steps are absent.
    for (const step of ["When it runs", "Where it runs", "What runs there", "What it can access"])
      await expect(this.page.getByRole("heading", { name: step, exact: true })).toBeVisible();
    const topbar = this.page.locator("header.sticky");
    await expect(topbar.getByRole("radio", { name: "Form" })).toBeEnabled();
    await expect(topbar.getByRole("radio", { name: "YAML" })).toBeVisible();
    await expect(topbar.getByRole("button", { name: "Discard" })).toBeVisible();
    await expect(this.page.getByLabel("Trigger ID")).toHaveCount(0);
  }

  /** No daemon yet: the steps after it keep their place and offer nothing to press. */
  async expectWaitingForDaemon(reason: "Choose a daemon first" | "Connect a daemon first") {
    await expect(this.page.getByText(reason, { exact: true })).toHaveCount(2);
    await expect(this.page.getByRole("combobox", { name: "Agent" })).toBeHidden();
    await expect(this.page.getByLabel("Working directory")).toBeHidden();
    await expect(this.page.getByLabel("Instructions", { exact: true })).toBeHidden();
    await expect(this.page.getByRole("button", { name: "Add integration" })).toBeHidden();
  }

  async chooseDaemon(daemon: string) {
    await this.selectOption("Daemon", daemon);
  }

  /** The directory picker suggests the daemon's projects, each by name over its path. */
  async expectProjectChoices(projects: readonly { name: string; path: string }[]) {
    await this.page.getByRole("combobox", { name: "Working directory", exact: true }).click();
    await expect(this.page.getByRole("option")).toHaveCount(projects.length);
    for (const project of projects) {
      await expect(
        this.page.getByRole("option", { name: `${project.name} ${project.path}`, exact: true }),
      ).toBeVisible();
    }
  }

  /** Narrows the open directory picker to one project and takes it. */
  async chooseListedProject(search: string, path: string) {
    await this.page.getByPlaceholder("Search projects or type a path…").fill(search);
    await expect(this.page.getByRole("option")).toHaveCount(1);
    await this.page.locator(`[role="option"][data-value=${JSON.stringify(path)}]`).click();
    await this.expectWorkingDirectory(path);
  }

  async expectWorkingDirectory(path: string) {
    await expect(
      this.page.getByRole("combobox", { name: "Working directory", exact: true }),
    ).toHaveAttribute("data-value", path);
  }

  /** Any absolute path is a working directory, whether or not the daemon suggested it. */
  async chooseWorkingDirectory(path: string) {
    await this.page.getByRole("combobox", { name: "Working directory", exact: true }).click();
    await this.page.getByPlaceholder("Search projects or type a path…").fill(path);
    await this.page.locator(`[role="option"][data-value=${JSON.stringify(path)}]`).click();
    await this.expectWorkingDirectory(path);
  }

  /** Even while project suggestions are still loading, typing an absolute path and pressing Enter selects it. */
  async chooseWorkingDirectoryWhileLoading(path: string) {
    await this.page.getByRole("combobox", { name: "Working directory", exact: true }).click();
    await expect(this.page.getByText("Loading…", { exact: true })).toBeVisible();
    const search = this.page.getByPlaceholder("Search projects or type a path…");
    await search.fill(path);
    await expect(
      this.page.locator(`[role="option"][data-value=${JSON.stringify(path)}]`),
    ).toBeVisible();
    await search.press("Enter");
    await this.expectWorkingDirectory(path);
  }

  /**
   * Typing an absolute path that prefixes a suggested project keeps the exact typed path as the
   * default Enter choice while leaving the matching project on offer for deliberate selection.
   */
  async chooseTypedPathOverMatchingProject(typedPath: string, matchingProjectPath: string) {
    await this.page.getByRole("combobox", { name: "Working directory", exact: true }).click();
    const search = this.page.getByPlaceholder("Search projects or type a path…");
    await search.fill(typedPath);
    await expect(
      this.page.locator(`[role="option"][data-value=${JSON.stringify(typedPath)}]`),
    ).toBeVisible();
    await expect(
      this.page.locator(`[role="option"][data-value=${JSON.stringify(matchingProjectPath)}]`),
    ).toBeVisible();
    await search.press("Enter");
    await this.expectWorkingDirectory(typedPath);
  }

  /** The audience sits closed under the event, and its header reads the current answer. */
  async expectAudience(audience: string) {
    await expect(this.audienceDisclosure()).toContainText(`Audience: ${audience}`);
    await expect(this.audienceDisclosure()).toHaveAttribute("aria-expanded", "false");
  }

  async openAudience() {
    await this.audienceDisclosure().click();
    await expect(this.page.getByRole("radiogroup", { name: "Audience" })).toBeVisible();
  }

  async expectAudienceChoices(audiences: readonly string[], chosen: string) {
    const group = this.page.getByRole("radiogroup", { name: "Audience" });
    await expect(group.getByRole("radio")).toHaveText([...audiences]);
    await expect(group.getByRole("radio", { name: chosen, exact: true })).toBeChecked();
  }

  async chooseAudience(audience: string) {
    await this.page
      .getByRole("radiogroup", { name: "Audience" })
      .getByRole("radio", { name: audience, exact: true })
      .click();
  }

  async chooseEvent(event: string) {
    await this.selectOption("Event", event);
  }

  async chooseConnection(connection: string) {
    await this.selectOption("Connection", connection);
  }

  async openContinuity() {
    await this.page.getByRole("button", { name: /Advanced.*Agent continuity/u }).click();
    await expect(this.page.getByRole("radiogroup", { name: "Agent continuity" })).toBeVisible();
  }

  private audienceDisclosure() {
    return this.page.getByRole("button", { name: /Advanced.*Audience/u });
  }

  /**
   * The organization's only daemon is already chosen, and the working directory is the one thing
   * the form does not guess: a prefilled path that did not exist on the daemon was saved as it was
   * and failed the first run, so the field starts empty.
   */
  async expectDaemonPreselected(daemon: string) {
    await expect(this.page.getByRole("combobox", { name: "Daemon", exact: true })).toHaveAttribute(
      "data-value",
      daemon,
    );
    const directory = this.page.getByRole("combobox", { name: "Working directory", exact: true });
    await expect(directory).toHaveAttribute("data-value", "");
    await expect(directory).toHaveAttribute("aria-required", "true");
  }

  /** Pressing save with the document as it is answers in the summary and stays on the editor. */
  async expectRefusedOnSubmit(reason: string) {
    const url = this.page.url();
    await this.page
      .locator("#trigger-editor-form")
      .getByRole("button", { name: /Create trigger|Save changes|Save YAML/u })
      .click();
    await expect(
      this.page
        .getByRole("alert")
        .filter({ hasText: /This trigger is not ready to save|Trigger not saved/u }),
    ).toContainText(reason);
    await expect(this.page).toHaveURL(url);
  }

  async exploreEventQualifiers() {
    await this.page.getByRole("combobox", { name: "Event", exact: true }).click();
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
    await this.selectOption("Event", "github.pull_request_label_added");
    await expect(this.page.getByRole("radio", { name: "Any label", exact: true })).toBeHidden();
    await expect(this.page.getByLabel("Added label", { exact: true })).toHaveValue("");

    await this.page.getByLabel("Added label", { exact: true }).fill("ready-for-review");
    await this.page.getByLabel("Added label", { exact: true }).scrollIntoViewIfNeeded();
    await this.page.screenshot({ path: "e2e/screenshots/triggers/added-label-qualifier.png" });
    await this.selectOption("Event", "github.issue_label_added");
    await expect(this.page.getByLabel("Added label", { exact: true })).toHaveValue(
      "ready-for-review",
    );
    await this.page.screenshot({ path: "e2e/screenshots/triggers/issue-label-qualifier.png" });
    await expect(this.page.getByLabel("Added label", { exact: true })).toHaveAttribute(
      "required",
      "",
    );
    await this.selectOption("Event", "slack.mention");
    await expect(this.page.getByLabel("Added label", { exact: true })).toBeHidden();
    await this.selectOption("Event", "github.pull_request_label_added");
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
    await this.selectOption("Event", "slack.mention");
    await this.selectOption("Connection", input.connection);
    // An event someone sends has an audience. A Slack mention starts open to the workspace, and
    // naming people is the choice behind the closed header.
    await this.expectAudience("Everyone");
    await this.openAudience();
    await this.expectAudienceChoices(["Everyone", "Specific people"], "Everyone");
    await this.chooseAudience("Specific people");
    await this.page.getByLabel("User IDs").fill(input.users);
    await this.selectOption("Daemon", input.daemon);
    await expect(this.page.getByRole("combobox", { name: "Agent" })).toHaveAttribute(
      "data-value",
      "",
    );
    await expect(this.page.getByRole("combobox", { name: "Execution mode" })).toBeHidden();
    await this.chooseWorkingDirectory(input.cwd);
    await this.selectAgent(input.agent);
    await this.selectOption("Execution mode", input.mode);
    await this.selectOption("Thinking", input.thinking);
    await this.page.getByRole("button", { name: "Advanced provider options" }).click();
    await this.page.getByLabel("Provider options (JSON)").fill(input.providerOptions);
    await this.page.getByLabel("Instructions", { exact: true }).fill(input.prompt);
  }

  async expectReportedModelChoices(cwd: string, labels: string[]) {
    await this.chooseWorkingDirectory(cwd);
    const picker = this.page.getByRole("combobox", { name: "Agent", exact: true });
    await picker.scrollIntoViewIfNeeded();
    await picker.click();
    await expect(this.page.getByRole("option")).toHaveCount(labels.length);
    for (const label of labels)
      await expect(this.page.getByRole("option").filter({ hasText: label })).toBeVisible();
    await this.page.keyboard.press("Escape");
  }

  async expectNoExecutionModes() {
    await expect(this.page.getByRole("combobox", { name: "Execution mode" })).toHaveCount(0);
  }

  async expectMaterializedSelections(mode: string, thinking: string) {
    await expect(this.page.getByRole("combobox", { name: "Execution mode" })).toHaveAttribute(
      "data-value",
      mode,
    );
    await expect(this.page.getByRole("combobox", { name: "Thinking" })).toHaveAttribute(
      "data-value",
      thinking,
    );
  }

  async configureManual(input: {
    name: string;
    daemon: string;
    cwd: string;
    agent: string;
    mode?: string;
    thinking?: string;
    providerOptions?: string;
    prompt: string;
  }) {
    await this.page.getByLabel("Trigger name").fill(input.name);
    await this.selectOption("Event", "manual.run");
    await this.selectOption("Daemon", input.daemon);
    await this.chooseWorkingDirectory(input.cwd);
    await this.selectAgent(input.agent);
    if (input.mode !== undefined) await this.selectOption("Execution mode", input.mode);
    if (input.thinking !== undefined) await this.selectOption("Thinking", input.thinking);
    if (input.providerOptions !== undefined) {
      await this.page.getByRole("button", { name: "Advanced provider options" }).click();
      await this.page.getByLabel("Provider options (JSON)").fill(input.providerOptions);
    }
    await this.page.getByLabel("Instructions", { exact: true }).fill(input.prompt);
  }

  async configureWebhook(daemon: string) {
    await this.configureManual({
      name: "webhook-alert",
      daemon,
      cwd: "/workspace/acme",
      agent: "opencode/gateway/vendor/model-v1",
      mode: "full-access",
      thinking: "low",
      prompt: "Summarize the alert.",
    });
    await this.selectOption("Event", "webhook.received");
  }

  async addScheduleBeforeWebhook() {
    await this.switchToYaml();
    const document = parseDocument(await this.readYaml(), { compat: ["timestamp"] });
    document.set("on", {
      "schedule.tick": {
        recurrence: { start: "2099-01-01T09:00:00", rule: "FREQ=DAILY", timezone: "UTC" },
      },
      "webhook.received": {},
    });
    await this.replaceYaml(document.toString({ lineWidth: 0 }));
  }

  async expectWebhookEndpoint() {
    await expect(this.page.getByRole("heading", { name: "Webhook endpoint" })).toBeVisible();
    const url = this.page.getByText(/https?:\/\/[^ ]+\/webhooks\/wh_[\w-]{32}$/u);
    await expect(url).toBeVisible();
    await expect(this.page.getByRole("button", { name: "Copy curl example" })).toBeVisible();
    return url.innerText();
  }

  async copyWebhookConnectionDetails(endpoint: string) {
    await allowClipboard(this.page, new URL(this.page.url()).origin);
    await this.page.getByRole("button", { name: "Copy Webhook URL" }).click();
    await expect
      .poll(() => this.page.evaluate(() => navigator.clipboard.readText()))
      .toBe(endpoint);
    await this.page.getByRole("button", { name: "Copy curl example" }).click();
    await expect
      .poll(() => this.page.evaluate(() => navigator.clipboard.readText()))
      .toContain(`curl -X POST '${endpoint}'`);
  }

  async createWebhookSecret() {
    await expect(this.page.getByText("No secret", { exact: true })).toBeVisible();
    await this.page.getByRole("button", { name: "Create secret", exact: true }).click();
    await expect(this.page.getByText("Save this secret now", { exact: true })).toBeVisible();
    const secret = this.page.getByRole("textbox", { name: "Webhook secret" });
    await expect(secret).toHaveValue(/^whsec_[\w-]{43}$/u);
    await expect(this.page.getByText("Secret active", { exact: true })).toBeVisible();
    return secret.inputValue();
  }

  async expectStaleWebhookCreationRefused() {
    await this.page.getByRole("button", { name: "Create secret", exact: true }).click();
    await expect(this.page.getByText("Webhook secret unavailable", { exact: true })).toBeVisible();
    await expect(this.page.getByText("Secret active", { exact: true })).toBeVisible();
    await expect(
      this.page.getByRole("button", { name: "Rotate secret", exact: true }),
    ).toBeVisible();
    await expect(this.page.getByRole("textbox", { name: "Webhook secret" })).toBeHidden();
  }

  async openWebhookInAnotherTab() {
    const tab = await this.page.context().newPage();
    await tab.goto(this.page.url());
    await expect(tab.getByRole("button", { name: "Create secret", exact: true })).toBeVisible();
    return new OrganizationTriggers(tab);
  }

  async rotateWebhookSecret() {
    await this.page.getByRole("button", { name: "Rotate secret", exact: true }).click();
    const dialog = this.page.getByRole("alertdialog", { name: "Rotate webhook secret?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Rotate secret", exact: true }).click();
    const secret = this.page.getByRole("textbox", { name: "Webhook secret" });
    await expect(secret).toHaveValue(/^whsec_[\w-]{43}$/u);
    return secret.inputValue();
  }

  async reloadWebhookSettings() {
    await this.page.reload();
    await expect(this.page.getByText("Secret active", { exact: true })).toBeVisible();
    await expect(
      this.page.getByRole("button", { name: "Rotate secret", exact: true }),
    ).toBeVisible();
    await expect(this.page.getByRole("textbox", { name: "Webhook secret" })).toBeHidden();
  }

  async configureSchedule(daemon: string) {
    await this.configureManual({
      name: "periodic-scan",
      daemon,
      cwd: "/workspace/acme",
      agent: "opencode/gateway/vendor/model-v1",
      mode: "full-access",
      thinking: "low",
      prompt: "Read reports and summarize new items.",
    });
    await this.selectOption("Event", "schedule.tick");
    await this.openContinuity();
    await this.page.getByRole("radio", { name: "New agent", exact: true }).check();
    await expect(this.page.getByRole("combobox", { name: "Connection", exact: true })).toBeHidden();
    // A schedule has no outside sender, so there is no audience to choose.
    await expect(this.audienceDisclosure()).toHaveCount(0);
    await this.expectSimpleScheduleControls();
    await this.page.getByLabel("Time 1", { exact: true }).fill("08:15");
    await this.page.getByRole("button", { name: "Add time", exact: true }).click();
    await this.page.getByLabel("Time 2", { exact: true }).fill("16:45");
    await this.page.getByRole("combobox", { name: "Timezone", exact: true }).click();
    await this.page.getByRole("option", { name: "Europe/Berlin", exact: true }).click();
    await expect(
      this.page
        .getByRole("status")
        .filter({ hasText: "Every day at 08:15 and 16:45 (Europe/Berlin)" }),
    ).toBeVisible();
  }

  async grantScheduledIntegrationTools() {
    await expect(
      this.page.getByRole("heading", { name: "What it can access", exact: true }),
    ).toBeVisible();
    await expect(this.page.getByText("No integrations granted", { exact: true })).toBeVisible();

    await this.addIntegrationAccess("GitHub");
    const github = this.page.getByRole("region", { name: "GitHub", exact: true });
    await expect(github.getByRole("combobox", { name: "Connection", exact: true })).toBeFocused();
    await expect(github.getByRole("combobox", { name: "Connection", exact: true })).toHaveAttribute(
      "data-value",
      "acme-inc-github",
    );
    await github.getByRole("textbox", { name: "Repositories", exact: true }).fill("acme-inc/hub");
    await github
      .getByRole("textbox", { name: "Permissions (JSON)", exact: true })
      .fill('{"contents":"write","pull_requests":"write"}');

    await this.addIntegrationAccess("Slack");
    const slack = this.page.getByRole("region", { name: "Slack", exact: true });
    await expect(slack.getByRole("combobox", { name: "Connection", exact: true })).toBeFocused();
    await expect(slack.getByRole("combobox", { name: "Connection", exact: true })).toHaveAttribute(
      "data-value",
      "company-slack",
    );
    await slack.getByRole("textbox", { name: "Channel IDs", exact: true }).fill("CALLOWED");
    await slack.getByRole("checkbox", { name: "Post messages", exact: true }).check();

    await this.addIntegrationAccess("Discord");
    const discord = this.page.getByRole("region", { name: "Discord", exact: true });
    await expect(discord.getByRole("combobox", { name: "Connection", exact: true })).toBeFocused();
    await expect(
      discord.getByRole("combobox", { name: "Connection", exact: true }),
    ).toHaveAttribute("data-value", "company-discord");
    await discord
      .getByRole("textbox", { name: "Channel IDs", exact: true })
      .fill("123456789012345678");
    await discord.getByRole("checkbox", { name: "Read messages", exact: true }).check();

    await expect(
      this.page.getByRole("button", { name: "Add integration", exact: true }),
    ).toHaveCount(0);
  }

  async addIntegrationAccess(provider: "GitHub" | "Slack" | "Discord") {
    await this.page.getByRole("button", { name: "Add integration", exact: true }).click();
    await this.page.getByRole("menuitem", { name: provider, exact: true }).click();
  }

  async expectScheduledIntegrationTools() {
    const github = this.page.getByRole("region", { name: "GitHub", exact: true });
    await expect(github.getByRole("combobox", { name: "Connection", exact: true })).toHaveAttribute(
      "data-value",
      "acme-inc-github",
    );
    await expect(github.getByRole("textbox", { name: "Repositories", exact: true })).toHaveValue(
      "acme-inc/hub",
    );
    await expect(
      github.getByRole("textbox", { name: "Permissions (JSON)", exact: true }),
    ).toHaveValue('{\n  "contents": "write",\n  "pull_requests": "write"\n}');

    const slack = this.page.getByRole("region", { name: "Slack", exact: true });
    await expect(slack.getByRole("textbox", { name: "Channel IDs", exact: true })).toHaveValue(
      "CALLOWED",
    );
    await expect(slack.getByRole("checkbox", { name: "Post messages", exact: true })).toBeChecked();

    const discord = this.page.getByRole("region", { name: "Discord", exact: true });
    await expect(discord.getByRole("textbox", { name: "Channel IDs", exact: true })).toHaveValue(
      "123456789012345678",
    );
    await expect(
      discord.getByRole("checkbox", { name: "Read messages", exact: true }),
    ).toBeChecked();
  }

  async editScheduleToWeekdays() {
    await this.page.getByRole("combobox", { name: "Repeat", exact: true }).click();
    await this.page.getByRole("option", { name: "Every week", exact: true }).click();
    await this.page.getByRole("checkbox", { name: "Friday", exact: true }).check();
    await this.page.getByRole("combobox", { name: "Repeat", exact: true }).click();
    await this.page.getByRole("option", { name: "Every week", exact: true }).click();
    await expect(this.page.getByRole("checkbox", { name: "Friday", exact: true })).toBeChecked();
    await this.page.getByLabel("Time 2", { exact: true }).fill("08:15");
    await this.page.getByRole("button", { name: "Save changes", exact: true }).first().click();
    await expect(
      this.page.getByRole("alert").filter({ hasText: "Check the recurrence" }),
    ).toContainText("Choose distinct times");
    await this.page.getByLabel("Time 2", { exact: true }).fill("18:30");
  }

  async expectScheduleAfterReload() {
    await this.page.reload();
    await this.expectSimpleScheduleControls();
    await expect(this.page.getByRole("checkbox", { name: "Monday", exact: true })).toBeChecked();
    await expect(this.page.getByRole("checkbox", { name: "Friday", exact: true })).toBeChecked();
    await expect(
      this.page.getByRole("checkbox", { name: "Tuesday", exact: true }),
    ).not.toBeChecked();
    await expect(this.page.getByLabel("Time 1", { exact: true })).toHaveValue("08:15");
    await expect(this.page.getByLabel("Time 2", { exact: true })).toHaveValue("18:30");
    await expect(
      this.page.getByRole("combobox", { name: "Thinking", exact: true }),
    ).toHaveAttribute("data-value", "low");
    await expect(this.page.getByLabel("Instructions", { exact: true })).toHaveValue(
      "Read reports and summarize new items.",
    );
  }

  async setSimpleSchedule(frequency: string) {
    await this.page.setViewportSize({ width: 1280, height: 1000 });
    await this.page.getByRole("combobox", { name: "Repeat", exact: true }).click();
    await this.page.getByRole("option", { name: frequency, exact: true }).click();
    await this.expectSimpleScheduleControls();
  }

  async expectSimpleScheduleControls() {
    await expect(this.page.getByLabel("Every", { exact: true })).toHaveCount(0);
    await expect(this.page.getByLabel("Starting", { exact: true })).toHaveCount(0);
    await expect(this.page.getByLabel("Custom schedule", { exact: true })).toHaveCount(0);
    await expect(
      this.page.getByRole("button", { name: "Edit recurrence rule", exact: true }),
    ).toHaveCount(0);
  }

  async expectHourlyAfterReload() {
    await this.page.reload();
    await expect(this.page.getByRole("combobox", { name: "Repeat", exact: true })).toContainText(
      "Every hour",
    );
    await this.expectSimpleScheduleControls();
    await expect(this.page.getByLabel("Time 1", { exact: true })).toHaveCount(0);
  }

  async useAdvancedScheduleRule(rule: string) {
    await this.switchToYaml();
    const document = parseDocument(await this.readYaml(), { compat: ["timestamp"] });
    document.setIn(["on", "schedule.tick", "recurrence", "rule"], rule);
    await this.replaceYaml(document.toString({ lineWidth: 0 }));
    await this.switchToForm();
    await expect(this.page.getByLabel("Custom schedule", { exact: true })).toHaveValue(rule);
    await expect(this.page.getByRole("combobox", { name: "Repeat", exact: true })).toHaveCount(0);
    await expect(this.page.getByLabel("Every", { exact: true })).toHaveCount(0);
  }

  async expectAdvancedScheduleRuleAfterReload(rule: string) {
    await this.page.reload();
    await expect(this.page.getByLabel("Custom schedule", { exact: true })).toHaveValue(rule);
    await this.page
      .getByLabel("Instructions", { exact: true })
      .fill("Read reports and summarize new items. Include links.");
  }

  async captureCustomSchedule(path: string) {
    await this.page.getByLabel("Custom schedule", { exact: true }).evaluate((element) => {
      window.scrollBy(0, element.getBoundingClientRect().top - 100);
    });
    await this.page.screenshot({ path });
  }

  async captureScheduleDetail(path: string) {
    await this.page.getByRole("combobox", { name: "Repeat", exact: true }).evaluate((element) => {
      window.scrollBy(0, element.getBoundingClientRect().top - 100);
    });
    await this.page.screenshot({ path });
  }

  async captureSchedule(path: string) {
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.screenshot({ path, fullPage: true });
  }

  async captureScheduleAtPhoneWidth(path: string) {
    await this.page.setViewportSize({ width: 390, height: 844 });
    await this.page.getByRole("combobox", { name: "Repeat", exact: true }).evaluate((element) => {
      window.scrollBy(0, element.getBoundingClientRect().top - 100);
    });
    expect(
      await this.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await this.page.screenshot({ path });
  }

  async runScheduledOccurrence(application: BuiltApplication, name: string) {
    // Move the fixture's persisted occurrence into the past; the production clock accepts it.
    await application.query(
      `update trigger_schedules set next_at = clock_timestamp() - interval '1 minute'
       where trigger_id = (select id from organization_triggers where name = $1)`,
      [name],
    );
    await expect
      .poll(async () => {
        const rows = await application.query(
          `select r.id from trigger_runs r
           join provider_event_receipts e on e.id = r.provider_event_receipt_id
           where e.source = 'schedule.tick'`,
        );
        return rows.length;
      })
      .toBe(1);
    await expect
      .poll(async () => {
        return await application.query(
          `select e.status, r.failure_reason from agent_executions e
           join workflow_step_runs s on s.agent_execution_id = e.id
           join trigger_runs r on r.id = s.trigger_run_id`,
        );
      })
      .toEqual([{ status: "running", failure_reason: null }]);
    await this.page.setViewportSize({ width: 1280, height: 900 });
    await this.page.getByRole("link", { name: "Activity", exact: true }).click();
    await expect(this.page).toHaveURL(/\/activity$/u);
    await this.page.reload();
    const row = this.page.getByRole("row").filter({ hasText: name });
    await expect(row.getByRole("cell", { name: "schedule", exact: true })).toBeVisible();
    await expect(row.getByRole("cell", { name: "schedule.tick", exact: true })).toBeVisible();
    await this.page.screenshot({ path: "e2e/screenshots/schedules/activity.png" });
  }

  async configureLabelAdded(input: { name: string; daemon: string; event: string }) {
    await this.configureManual({
      name: input.name,
      daemon: input.daemon,
      cwd: "/workspace/acme",
      agent: "opencode/gateway/vendor/model-v1",
      mode: "full-access",
      thinking: "high",
      prompt: "Handle the labeled item.",
    });
    await this.selectOption("Event", input.event);
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
    ).toContainText("Added label is required");
    await expect(this.page.getByLabel("Added label", { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(this.page).toHaveURL(url);
  }

  async expectPersistedLabel(event: string, label: string) {
    await this.page.reload();
    await expect(this.page.getByRole("combobox", { name: "Event", exact: true })).toHaveAttribute(
      "data-value",
      event,
    );
    await expect(this.page.getByLabel("Added label", { exact: true })).toHaveValue(label);
    await this.switchToYaml();
    expect(parseDocument(await this.readYaml()).toJS()).toMatchObject({
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

  async exerciseContinuity() {
    await this.openContinuity();
    await expect(
      this.page.getByRole("radio", { name: "Same conversation", exact: true }),
    ).toBeChecked();
    await this.page.getByRole("radio", { name: "Custom key", exact: true }).click();
    await expect(this.page.getByRole("radio", { name: "Custom key", exact: true })).toBeChecked();
    await this.page.getByLabel("Continuation key", { exact: true }).fill("support-ticket");
    await this.capture("e2e/screenshots/triggers/continuation-key.png");
    await this.page.getByRole("radio", { name: "New agent", exact: true }).click();
    await expect(this.page.getByLabel("Continuation key", { exact: true })).toBeHidden();
    await this.page.getByRole("radio", { name: "Same conversation", exact: true }).click();
    await expect(
      this.page.getByRole("button", { name: /Advanced.*Agent continuity: Same conversation/u }),
    ).toBeVisible();
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
      "Event",
      "Connection",
      "Daemon",
      "Working directory",
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

  async nameTrigger(name: string) {
    await this.page.getByLabel("Trigger name").fill(name);
  }

  async expectYamlMatches(expected: Record<string, unknown>) {
    expect(parseDocument(await this.readYaml()).toJS()).toMatchObject(expected);
  }

  async expectYamlOmits(fragment: string) {
    expect(await this.readYaml()).not.toContain(fragment);
  }

  async expectYamlContains(...fragments: string[]) {
    const yaml = await this.readYaml();
    for (const fragment of fragments) expect(yaml).toContain(fragment);
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
    for (const name of ["Advanced provider options", "Agent continuity"]) {
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

  async selectAgent(agentId: string) {
    await this.page.getByRole("combobox", { name: "Agent" }).click();
    await this.page.locator(`[role="option"][data-value=${JSON.stringify(agentId)}]`).click();
  }

  private async selectOption(label: string, value: string) {
    await this.page.getByRole("combobox", { name: label, exact: true }).click();
    await this.page.locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
  }

  private async readYaml() {
    await allowClipboard(this.page, new URL(this.page.url()).origin);
    await this.page.getByRole("button", { name: "Copy Trigger YAML", exact: true }).click();
    return this.page.evaluate(() => navigator.clipboard.readText());
  }

  private yamlEditor() {
    return this.page.getByRole("textbox", { name: "Trigger YAML" });
  }
}
