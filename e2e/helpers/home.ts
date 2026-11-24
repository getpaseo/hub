import { expect, type Locator, type Page } from "@playwright/test";

export type HomeRange = "24h" | "7d" | "30d";
export type HomeFigure = "Runs" | "Failed" | "Daemons";

export type ChecklistStepTitle =
  | "Connect an integration"
  | "Connect a daemon"
  | "Create a trigger"
  | "Run it";

export type ChecklistStepState = "done" | "to do" | "needs attention";

/**
 * The organization landing: the checklist and the overview under it. Steps are addressed by
 * their title. Only the current step shows its hint and action, so the DSL asks which step is
 * current before it reads what that step says. The overview's figures, triggers, and daemons
 * each open Activity already filtered to what they count.
 */
export class OrganizationHome {
  constructor(private readonly page: Page) {}

  async open() {
    await this.page.getByRole("link", { name: "Home", exact: true }).click();
    await this.expectOpen();
  }

  async expectOpen() {
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/home(\?.*)?$/u);
    await expect(this.page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  }

  async reload() {
    await this.page.reload();
    await this.expectOpen();
  }

  step(title: ChecklistStepTitle): Locator {
    return this.page
      .getByRole("list", { name: "Get started" })
      .getByRole("listitem")
      .filter({ hasText: title });
  }

  /** A step's state is announced after its title, the way a screen reader hears it. */
  async expectStep(title: ChecklistStepTitle, state: ChecklistStepState) {
    await expect(this.step(title)).toContainText(`${title}, ${state}`);
  }

  /** The one open step: its hint and its action are the only ones on screen. */
  async expectCurrentStep(title: ChecklistStepTitle) {
    await expect(
      this.page.getByRole("list", { name: "Get started" }).locator('[aria-current="step"]'),
    ).toContainText(title);
  }

  /** What a step says: a done step's result, or the current step's hint. */
  async expectStepText(title: ChecklistStepTitle, text: string) {
    await expect(this.step(title)).toContainText(text);
  }

  /** A new organization reads the checklist alone: nothing below it until a run exists. */
  async expectNoOverview() {
    await expect(this.page.getByRole("radiogroup", { name: "Range" })).toHaveCount(0);
    await expect(this.page.getByRole("table", { name: "Triggers" })).toHaveCount(0);
  }

  /**
   * On a phone a done step's title stays whole and inside its row; its result is what gives way.
   * The title and the result used to share the row's shrink, so a 375px screen read
   * "Connect an integr…" beside a cut-off result.
   */
  async expectWholeTitlesAtPhoneWidth(titles: readonly ChecklistStepTitle[]) {
    const viewport = this.page.viewportSize();
    await this.page.setViewportSize({ width: 375, height: 800 });
    for (const title of titles) {
      const step = this.step(title);
      const fit = await step.getByText(title).evaluate((element: HTMLElement) => {
        const row = element.closest("li")?.getBoundingClientRect();
        return {
          clipped: element.scrollWidth > element.clientWidth,
          inside: row !== undefined && element.getBoundingClientRect().right <= row.right,
        };
      });
      expect(fit, title).toEqual({ clipped: false, inside: true });
    }
    if (viewport !== null) await this.page.setViewportSize(viewport);
  }

  async expectProgress(progress: string) {
    await expect(this.page.getByRole("button", { name: /Get started/u })).toContainText(progress);
  }

  /** The list is hidden once every step is done; the header stays, and a click brings it back. */
  async expectCollapsed() {
    await expect(this.page.getByRole("list", { name: "Get started" })).toBeHidden();
  }

  async toggle() {
    await this.page.getByRole("button", { name: /Get started/u }).click();
  }

  async expectExpanded() {
    await expect(this.page.getByRole("list", { name: "Get started" })).toBeVisible();
  }

  /** The command a row tells the reader to run, as rendered. */
  command(title: ChecklistStepTitle): Locator {
    return this.step(title).locator("span.font-mono");
  }

  async followStepAction(title: ChecklistStepTitle, name: string) {
    await this.step(title).getByRole("link", { name, exact: true }).click();
  }

  /** Home raises no alert: events no trigger matched are a link under Triggers, not a fault. */
  async expectNoAlert() {
    await expect(this.page.getByRole("alert")).toHaveCount(0);
  }

  /** A connection Hub cannot use as it stands is the one fault Home raises. */
  async expectConnectionFault(fault: string) {
    const alert = this.page.getByRole("alert");
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText("A connection needs attention");
    await expect(alert).toContainText(fault);
  }

  async openIntegrationsFromAlert() {
    await this.page.getByRole("alert").getByRole("link", { name: "Open integrations" }).click();
    await expect(this.page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();
  }

  async chooseRange(range: HomeRange) {
    await this.page
      .getByRole("radiogroup", { name: "Range" })
      .getByRole("radio", { name: range, exact: true })
      .click();
    await expect
      .poll(() => new URL(this.page.url()).searchParams.get("range"))
      .toBe(range === "7d" ? null : range);
  }

  /** A figure is a tile that opens the records it counts, so it is found as the link it is. */
  figure(label: HomeFigure): Locator {
    return this.page.getByRole("link", { name: new RegExp(`^${label}\\s*\\d`, "u") });
  }

  async expectFigure(label: HomeFigure, value: string, detail: string) {
    await expect(this.figure(label)).toContainText(`${label}${value}`);
    await expect(this.figure(label)).toContainText(detail);
  }

  async openFigure(label: HomeFigure) {
    await this.figure(label).click();
  }

  trigger(name: string): Locator {
    return this.page
      .getByRole("table", { name: "Triggers" })
      .getByRole("row")
      .filter({ has: this.page.getByRole("link", { name, exact: true }) });
  }

  /** A trigger's runs and failures in the range, in the order the columns read. */
  async expectTrigger(name: string, counts: { runs: number; failed: number }) {
    const cells = this.trigger(name).getByRole("cell");
    await expect(cells.nth(1)).toHaveText(counts.runs.toLocaleString("en-US"));
    await expect(cells.nth(2)).toHaveText(counts.failed.toLocaleString("en-US"));
  }

  async openTrigger(name: string) {
    await this.trigger(name).getByRole("link", { name, exact: true }).click();
  }

  async openUnmatchedEvents() {
    await this.page.getByRole("link", { name: "Unmatched events", exact: true }).click();
  }

  async openDaemonRuns(daemon: string) {
    await this.page.getByRole("link", { name: `View runs on ${daemon}`, exact: true }).click();
  }

  async capture(path: string) {
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.screenshot({ path, fullPage: true });
  }
}
