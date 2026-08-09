import { expect, type Page } from "@playwright/test";

export class RoutingAudit {
  constructor(private readonly page: Page) {}

  async expectKnownUnroutedReason(reason: string): Promise<void> {
    const table = this.page.getByRole("table", { name: "Unrouted events" });
    await expect(table).toBeVisible();
    await expect(table).toContainText("Reason");
    await expect(table).toContainText(reason);
  }

  async expandTriggerDecisions(): Promise<void> {
    const table = this.page.getByRole("table", { name: "Unrouted events" });
    await table.getByText("View trigger decisions", { exact: true }).click();
    await expect(
      table.getByRole("listitem").filter({ hasText: "sender_not_allowed" }),
    ).toBeVisible();
    await expect(table.getByRole("listitem").filter({ hasText: "pattern_mismatch" })).toBeVisible();
  }

  async expectNoSensitiveRoutingEvidence(): Promise<void> {
    const table = this.page.getByRole("table", { name: "Unrouted events" });
    for (const value of ["PRIVATE-EVENT-BODY", "U2", "C1", "PRIVATE-TOKEN"]) {
      await expect(table).not.toContainText(value);
    }
  }
}
