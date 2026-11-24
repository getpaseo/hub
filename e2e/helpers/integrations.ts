import { expect, type Page } from "@playwright/test";

/**
 * The organization's Integrations screen. Each connected provider's card ends in links to that
 * provider's runs and unmatched events in Activity.
 */
export class OrganizationIntegrations {
  constructor(private readonly page: Page) {}

  async open() {
    await this.page.getByRole("link", { name: "Integrations", exact: true }).click();
    await expect(this.page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();
  }

  async openProviderRuns(provider: string) {
    await this.page.getByRole("link", { name: `View ${provider} runs`, exact: true }).click();
  }

  async openProviderUnmatchedEvents(provider: string) {
    await this.page
      .getByRole("link", { name: `${provider} unmatched events`, exact: true })
      .click();
  }
}
