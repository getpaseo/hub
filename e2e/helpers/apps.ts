import { expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

export type AppProvider = "GitHub" | "Slack" | "Discord";

export type AppStatus =
  | "Not set up"
  | "Verified"
  | "Connected"
  | "Action needed"
  | "Managed by environment";

const APP_SUMMARIES: Readonly<Record<AppProvider, string>> = {
  GitHub: "Reads issues and pull requests, and lets agents push.",
  Slack: "Reads mentions in your workspace and replies in the thread.",
  Discord: "Reads mentions in your server and replies in the thread.",
};

/** The credentials the fixture providers accept. Anything else is a genuine rejection. */
export const WORKING_CREDENTIALS: Readonly<Record<AppProvider, Readonly<Record<string, string>>>> =
  {
    GitHub: {
      "App ID": "42",
      "App slug": "paseo",
      "Client ID": "client",
      "Client secret": "secret",
      "Private key": "fixture-private-key",
      "Webhook secret": "phase-zero-webhook-secret",
    },
    Discord: {
      "Application ID": "900",
      "Client Secret": "secret",
      "Bot token": "token",
    },
    Slack: {
      "App ID": "browser-slack-app",
      "Client ID": "browser-slack-client",
      "Client Secret": "browser-slack-client-secret",
      "Signing Secret": "phase-zero-slack-webhook-secret",
    },
  };

/**
 * One provider's collapsible section. Everything is addressed by role and accessible name, so a
 * passing journey is also evidence that the section is reachable without sight or a pointer.
 */
export class AppSection {
  constructor(
    private readonly page: Page,
    readonly provider: AppProvider,
  ) {}

  private get root(): Locator {
    return this.page.locator(`[data-provider="${this.provider.toLowerCase()}"]`);
  }

  header(): Locator {
    return this.root.getByRole("button", { name: this.provider, exact: false }).first();
  }

  body(): Locator {
    return this.root.getByRole("region", { name: this.provider });
  }

  form(): Locator {
    return this.page.getByRole("form", { name: `Set up ${this.provider}` });
  }

  status(): Locator {
    return this.page.getByRole("status", { name: `${this.provider} status` });
  }

  async expectStatus(status: AppStatus): Promise<void> {
    await expect(this.header()).toContainText(status);
  }

  async expectCollapsed(): Promise<void> {
    await expect(this.header()).toHaveAttribute("aria-expanded", "false");
    await expect(this.body()).toBeHidden();
  }

  async expectExpanded(): Promise<void> {
    await expect(this.header()).toHaveAttribute("aria-expanded", "true");
    await expect(this.body()).toBeVisible();
  }

  async expectCompactHeaderLayout(): Promise<void> {
    const title = await this.header().getByText(this.provider, { exact: true }).boundingBox();
    const description = await this.header()
      .getByText(APP_SUMMARIES[this.provider], { exact: true })
      .boundingBox();
    const status = await this.header()
      .getByText(/^(?:Not set up|Verified|Connected|Action needed|Managed by environment)$/u)
      .boundingBox();
    expect(title).not.toBeNull();
    expect(description).not.toBeNull();
    expect(status).not.toBeNull();
    expect(description!.y).toBeGreaterThan(title!.y);
    expect(status!.y).toBeGreaterThan(description!.y);
    expect(status!.x).toBeLessThan(title!.x + 8);
  }

  async expand(): Promise<void> {
    await expect(this.page.getByLabel("Loading your apps")).toHaveCount(0);
    if ((await this.header().getAttribute("aria-expanded")) === "true") return;
    await this.header().click();
    await this.expectExpanded();
  }

  async collapse(): Promise<void> {
    await expect(this.page.getByLabel("Loading your apps")).toHaveCount(0);
    if ((await this.header().getAttribute("aria-expanded")) === "false") return;
    await this.header().click();
    await this.expectCollapsed();
  }

  /** Toggling never steals focus: the operator stays on the control they pressed. */
  async toggleFromKeyboard(): Promise<void> {
    await this.header().focus();
    await this.page.keyboard.press("Enter");
    await expect(this.header()).toBeFocused();
  }

  async fill(values: Readonly<Record<string, string>>): Promise<void> {
    for (const [label, value] of Object.entries(values)) {
      await this.form().getByLabel(label, { exact: true }).fill(value);
    }
  }

  async fillWorkingCredentials(): Promise<void> {
    await this.fill(WORKING_CREDENTIALS[this.provider]);
  }

  async value(label: string): Promise<string> {
    return await this.form().getByLabel(label, { exact: true }).inputValue();
  }

  action(name: string): Locator {
    return this.body().getByRole("button", { name, exact: true });
  }

  async save(): Promise<void> {
    await this.action(
      this.provider === "Slack" ? "Save and continue to Slack" : "Verify and save",
    ).click();
  }

  /** Presses a copy control and reads back what actually reached the clipboard. */
  async copiedValue(label: string): Promise<string> {
    await this.body()
      .getByRole("button", { name: `Copy ${label}`, exact: true })
      .click();
    return await this.page.evaluate(() => navigator.clipboard.readText());
  }

  /** The Slack manifest block, whose control carries its own visible label. */
  async copiedManifest(): Promise<string> {
    await this.body().getByRole("button", { name: "Copy manifest", exact: true }).click();
    return await this.page.evaluate(() => navigator.clipboard.readText());
  }

  async expectGeneratedUrl(label: string, expected: string): Promise<void> {
    await expect(this.body().getByText(expected, { exact: true })).toBeVisible();
    expect(await this.copiedValue(label)).toBe(expected);
  }

  async expectFieldError(message: string): Promise<void> {
    await expect(this.form().getByText(message, { exact: true })).toBeVisible();
  }

  async expectResult(message: string | RegExp): Promise<void> {
    await expect(this.status()).toContainText(message);
  }

  /** The section reports what happened and takes the keyboard with it. */
  async expectFocusedResult(message: string | RegExp): Promise<void> {
    await this.expectResult(message);
    await expect(this.status()).toBeFocused();
  }

  async expectFocusedError(message: string | RegExp): Promise<void> {
    const alert = this.status().getByRole("alert");
    await expect(alert).toContainText(message);
    await expect(alert).toBeFocused();
  }

  /** Plain HTTP is a terminal Slack setup state, not an editable workflow with disabled inputs. */
  async expectHttpsBlocked(): Promise<void> {
    await this.expectExpanded();
    await expect(
      this.body().getByText("Slack requires Hub to use HTTPS before you can set it up.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(this.body().getByRole("link", { name: "Create a Slack app" })).toHaveCount(0);
    await expect(this.body().getByRole("list")).toHaveCount(0);
    await expect(this.body().getByRole("button", { name: "Copy manifest" })).toHaveCount(0);
    await expect(this.form()).toHaveCount(0);
    await expect(this.action("Save and continue to Slack")).toHaveCount(0);
  }

  /** HTTPS exposes every user action needed to create and install the Slack app. */
  async expectSlackSetupActionable(origin: string): Promise<void> {
    await this.expectExpanded();
    await expect(this.body().getByRole("link", { name: "Create a Slack app" })).toBeVisible();
    await expect(this.body().getByRole("list")).toBeVisible();
    await expect(this.body().getByRole("button", { name: "Copy manifest" })).toBeVisible();
    await expect(this.form()).toBeVisible();
    for (const label of Object.keys(WORKING_CREDENTIALS.Slack)) {
      await expect(this.form().getByLabel(label, { exact: true })).toBeEnabled();
    }
    await expect(this.action("Save and continue to Slack")).toBeEnabled();
    expect(await this.copiedManifest()).toContain(`${origin}/api/integrations/slack/callback`);
  }
}

/**
 * The app setup surface, in either frame. The first-run journey and Instance → Apps render the
 * same sections, so one page object drives both and any divergence shows up as a failure.
 */
export class AppSetupSurface {
  readonly github: AppSection;
  readonly slack: AppSection;
  readonly discord: AppSection;

  constructor(private readonly page: Page) {
    this.github = new AppSection(page, "GitHub");
    this.slack = new AppSection(page, "Slack");
    this.discord = new AppSection(page, "Discord");
  }

  sections(): readonly AppSection[] {
    return [this.github, this.slack, this.discord];
  }

  section(provider: AppProvider): AppSection {
    return provider === "GitHub" ? this.github : provider === "Slack" ? this.slack : this.discord;
  }

  async expectOnboarding(): Promise<void> {
    await expect(this.page.getByRole("heading", { name: "Set up your apps" })).toBeVisible();
    await expect(
      this.page.getByText(
        "Paseo Hub talks to GitHub, Slack, and Discord through apps you create and own.",
        { exact: false },
      ),
    ).toBeVisible();
    await this.expectCopyContract();
  }

  async expectManagement(): Promise<void> {
    await expect(this.page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
    await expect(
      this.page.getByText("The GitHub, Slack, and Discord apps this Hub uses."),
    ).toBeVisible();
  }

  wayOut(label: "Finish" | "Do this later"): Locator {
    return this.page.getByRole("button", { name: label, exact: true });
  }

  async leave(label: "Finish" | "Do this later"): Promise<void> {
    await this.wayOut(label).click();
    await expect(this.page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  }

  async expectStatuses(expected: Readonly<Record<AppProvider, AppStatus>>): Promise<void> {
    for (const section of this.sections()) await section.expectStatus(expected[section.provider]);
  }

  /** Only one section open at a time is an accordion's rule, not this surface's. */
  async expectIndependentCollapse(): Promise<void> {
    await this.github.expand();
    await this.slack.expand();
    await this.github.expectExpanded();
    await this.slack.expectExpanded();
    await this.discord.expectCollapsed();
  }

  async collapseAll(): Promise<void> {
    for (const section of this.sections()) await section.collapse();
  }

  async expandAll(): Promise<void> {
    for (const section of this.sections()) await section.expand();
  }

  async verifyGitHubFromKeyboard(): Promise<void> {
    const github = this.github;
    await github.expectExpanded();
    // The loading surface deliberately exposes the same static instructions and controls.
    // Wait for the dynamic form before starting the uninterrupted tab-order assertion so
    // hydration cannot replace the currently focused node halfway through the journey.
    await expect(github.form()).toBeVisible();
    await github.header().focus();
    await this.tabTo(github.body().getByRole("link", { name: "Create a GitHub App" }));
    for (const label of ["Homepage URL", "Callback URL", "Setup URL", "Webhook URL"]) {
      await this.tabTo(github.body().getByRole("button", { name: `Copy ${label}` }));
    }
    for (const [label, value] of Object.entries(WORKING_CREDENTIALS.GitHub)) {
      const field = github.form().getByLabel(label, { exact: true });
      await this.tabTo(field);
      await field.fill(value);
    }
    await this.tabTo(github.action("Verify and save"));
    await this.page.keyboard.press("Enter");
  }

  private async tabTo(target: Locator): Promise<void> {
    await this.page.keyboard.press("Tab");
    await expect(target).toBeFocused();
  }

  async accessible(): Promise<void> {
    const results = await new AxeBuilder({ page: this.page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  }

  async expectCopyContract(): Promise<void> {
    const copy = (await this.page.locator("body").innerText()).toLowerCase();
    for (const phrase of [
      "runtime configuration",
      "persistence",
      "database",
      "storage",
      "migration",
      "provider registration",
      "factory",
      "hot reload",
      "restart",
      "activation",
      "environment precedence",
      "latch",
      "configuration version",
      "snapshot",
      "first owner",
      "instance operator flag",
      "project",
      "projects",
    ]) {
      expect(copy, `visible copy contains prohibited phrase: ${phrase}`).not.toContain(phrase);
    }
  }

  /** Evidence, not an assertion. Animations are frozen so a shot never catches a mid-transition. */
  async shoot(directory: string, name: string): Promise<void> {
    await this.page.screenshot({
      path: `${directory}/${name}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
}

/** Grants clipboard access so copy affordances can be proven, not just clicked. */
export async function allowClipboard(page: Page, origin: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
}
