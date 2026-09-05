import { expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * The step between app setup and the dashboard: one command to run in a terminal, and a poll
 * waiting for the daemon it connects. Both ways out land on the dashboard, so every journey that
 * used to leave app setup for the dashboard still passes straight through.
 */
export class DaemonHandoffSurface {
  constructor(private readonly page: Page) {}

  /**
   * The copy control announces itself through a live region of its own, so the poll is named by
   * what it is polling for rather than by being the only status on the card.
   */
  async expectWaiting(): Promise<void> {
    await expect(this.page.getByRole("heading", { name: "Connect a daemon" })).toBeVisible();
    await expect(this.page.getByRole("status").filter({ hasText: /daemon/u })).toContainText(
      "Waiting for a daemon to connect",
    );
  }

  /** The exact command the operator is told to paste, as it is rendered. */
  command(): Locator {
    return this.page.getByText(/^paseo hub login/u);
  }

  async expectCommand(expected: string): Promise<void> {
    await expect(this.command()).toHaveText(expected);
  }

  async copyCommand(): Promise<string> {
    await this.page.getByRole("button", { name: "Copy Command", exact: true }).click();
    return await this.page.evaluate(() => navigator.clipboard.readText());
  }

  async expectConnected(slug: string): Promise<void> {
    await expect(this.page.getByRole("heading", { name: "Daemon connected" })).toBeVisible();
    await expect(this.page.getByRole("status")).toContainText(`${slug} is connected to this Hub`);
  }

  async accessible(): Promise<void> {
    const results = await new AxeBuilder({ page: this.page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  }

  /**
   * Both ways out land in the project instance setup already provisioned. Onboarding never hands
   * the operator a list with one entry on it and asks them to pick.
   */
  async leave(label: "Continue" | "Do this later"): Promise<void> {
    await this.page.getByRole("button", { name: label, exact: true }).click();
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/triggers$/u);
    await expect(this.page.getByRole("heading", { name: "Triggers", level: 1 })).toBeVisible();
  }
}
