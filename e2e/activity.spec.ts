import { expect } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationActivity } from "./helpers/activity.js";
import { OrganizationDaemons } from "./helpers/daemons.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const SHOTS = "e2e/screenshots/activity";
const owner = {
  name: "Activity Owner",
  email: "activity-owner@example.com",
  password: "activity-owner-password",
};
const FAILURE = "The agent exited before it finished";

test.describe.configure({ timeout: 180_000 });

/**
 * An operator reading what their organization did: the runs its triggers started, narrowed,
 * ordered, and paged, one run opened beside the list, and the events that started nothing with
 * what to do about each. The URL carries all of it, so every step survives a reload.
 */
test("pages, filters, sorts, and opens runs and unmatched events from the URL", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.connectGitHub("owner");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  const triggers = new OrganizationTriggers(page);
  const activity = new OrganizationActivity(page);
  const daemons = new OrganizationDaemons(page);

  await test.step("seed two triggers, 31 runs, and two events no trigger matched", async () => {
    await triggers.open();
    for (const name of ["deploy", "triage"]) {
      await triggers.startNew();
      await triggers.configureManual({
        name,
        daemon,
        cwd: "/workspace",
        agent: "codex/gpt-5.4",
        mode: "full-access",
        thinking: "high",
        prompt: "Handle the event.",
      });
      await triggers.save(name);
    }
    for (let run = 1; run <= 30; run += 1) {
      await hub.seedTriggerRun("deploy", {
        minutesAgo: 10 + run * 10,
        status: "succeeded",
        durationMinutes: run,
      });
    }
    await hub.seedTriggerRun("triage", {
      minutesAgo: 5,
      status: "failed",
      durationMinutes: 2,
      failureReason: FAILURE,
    });
    await hub.deliverUnroutedGitHubEvent("activity-unmatched-1");
    await hub.deliverUnroutedGitHubEvent("activity-unmatched-2");
  });

  await test.step("the runs list pages through every run in the range", async () => {
    await activity.open();
    await activity.expectRows("Runs", 25);
    await activity.expectPageRange("Runs", "1–25 of 31");
    await expect(activity.rows("Runs").first()).toContainText("triage");
    await activity.nextPage("Runs");
    await activity.expectRows("Runs", 6);
    await activity.expectPageRange("Runs", "26–31 of 31");
    await activity.expectLastPage("Runs");
    await activity.expectUrl({ page: "2" });
    await activity.previousPage("Runs");
    await activity.expectPageRange("Runs", "1–25 of 31");
    await activity.expectUrl({ page: null });
  });

  await test.step("a link past the last page leads back to the first", async () => {
    await activity.visitPage(3);
    await activity.returnToFirstPage("No more runs");
    await activity.expectUrl({ page: null });
    await activity.expectPageRange("Runs", "1–25 of 31");
  });

  await test.step("a failure filter narrows the list, survives a reload, and clears", async () => {
    await activity.filter("Status", "Any failure");
    await activity.expectRows("Runs", 1);
    await expect(activity.row("Runs", "triage")).toContainText("Failed");
    await activity.reload();
    await activity.expectRows("Runs", 1);
    await expect(page.getByRole("combobox", { name: "Status" })).toContainText("Any failure");
    await activity.clearFilters();
    await activity.expectRows("Runs", 25);
    await activity.expectUrl({ status: null });
  });

  await test.step("a search finds runs by trigger", async () => {
    await activity.search("Search runs", "triage");
    await activity.expectRows("Runs", 1);
    await activity.expectUrl({ q: "triage" });
    await activity.clearFilters();
    await activity.expectRows("Runs", 25);
  });

  await test.step("sorting by duration puts the longest run first, then the shortest", async () => {
    await activity.sortBy("Runs", "Duration");
    await activity.expectSorted("Runs", "Duration", "descending");
    await expect(activity.rows("Runs").first()).toContainText("30m 00s");
    await activity.sortBy("Runs", "Duration");
    await activity.expectSorted("Runs", "Duration", "ascending");
    await expect(activity.rows("Runs").first()).toContainText("1m 00s");
    await activity.expectUrl({ sort: "duration", dir: "asc" });
    await activity.sortBy("Runs", "Received");
    await activity.expectSorted("Runs", "Received", "descending");
  });

  await test.step("a run opens beside the list, survives a reload, and closes with Escape", async () => {
    await activity.openRecord("Runs", "triage");
    await activity.expectRecord("triage");
    await expect(activity.record()).toContainText("Run failed");
    await expect(activity.record()).toContainText(FAILURE);
    await expect(activity.record().getByRole("link", { name: "Edit trigger" })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("selected")).not.toBeNull();
    await activity.reload();
    await activity.expectRecord("triage");
    await activity.capture(`${SHOTS}/01-run-drawer.png`);
    await activity.stepRecord("Next record");
    await activity.expectRecord("deploy");
    await activity.expectCopiedLinkIsThisView();
    await activity.expectCopyLinkFallbackWhenClipboardIsBlocked();
    await activity.closeRecordWithEscape();
    await activity.expectUrl({ selected: null });
    await activity.expectRows("Runs", 25);
  });

  await test.step("unmatched events say why they started nothing and what to do next", async () => {
    await activity.showWhileTheListLoads("Unmatched events", "Runs");
    await activity.expectUrl({ view: "unmatched" });
    await activity.expectRows("Unmatched events", 2);
    await expect(activity.rows("Unmatched events").first()).toContainText("No route for repo");
    await activity.openFirstRecord("Unmatched events");
    await activity.expectRecord("No trigger covers this repository");
    await expect(activity.record().getByRole("link", { name: "Create trigger" })).toBeVisible();
    await expect(activity.record().getByRole("button", { name: "Event payload" })).toBeVisible();
    await activity.capture(`${SHOTS}/02-unmatched-drawer.png`);
    await activity.record().getByRole("button", { name: "Filter by this reason" }).click();
    await activity.expectUrl({ view: "unmatched", reason: "no_project_route", selected: null });
    await activity.expectRows("Unmatched events", 2);
    await activity.reload();
    await expect(page.getByRole("combobox", { name: "Reason" })).toContainText("No route for repo");
  });

  await test.step("a trigger's last run and its editor open Activity on that trigger", async () => {
    await triggers.open();
    await triggers.expectLastTriggered("triage", "Failed");
    await triggers.openLastTriggered("triage");
    await activity.expectOpen();
    await activity.expectUrl({ range: "all" });
    await activity.expectRows("Runs", 1);
    await expect(page.getByRole("combobox", { name: "Trigger" })).toContainText("triage");
    await triggers.open();
    await triggers.openTrigger("deploy");
    await triggers.openTriggerActivity();
    await activity.expectOpen();
    await activity.expectRows("Runs", 25);
    await activity.expectPageRange("Runs", "1–25 of 30");
  });

  await test.step("a daemon's row actions open Activity filtered to that daemon", async () => {
    await daemons.open();
    await daemons.openActivity(daemon);
    await activity.expectOpen();
    await expect.poll(() => new URL(page.url()).searchParams.get("daemon")).not.toBeNull();
    await expect(page.getByRole("combobox", { name: "Daemon" })).toContainText(daemon);
  });
});
