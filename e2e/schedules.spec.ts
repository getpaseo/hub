import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

test("creates a twice-daily schedule, edits weekly recurrence, and preserves it through YAML and reload", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", {
    name: "Schedule Owner",
    email: "schedule-owner@example.com",
    password: "schedule-owner-password",
  });
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  const triggers = new OrganizationTriggers(page);
  await test.step("create a twice-daily schedule using normal execution settings", async () => {
    await triggers.open();
    await triggers.startNew();
    await triggers.configureSchedule(daemon);
    await triggers.captureSchedule("e2e/screenshots/schedules/daily.png");
    await triggers.switchToYaml();
    await triggers.expectYamlContains(
      "schedule.tick:",
      "frequency: daily",
      "Europe/Berlin",
      "thinkingOptionId: low",
    );
    await triggers.save("periodic-scan");
  });
  await test.step("edit recurrence, validate duplicate times, save and reload", async () => {
    await triggers.openTrigger("periodic-scan");
    await triggers.editScheduleToWeekdays();
    await triggers.save("periodic-scan");
    await triggers.capture("e2e/screenshots/schedules/summary.png");
    await triggers.openTrigger("periodic-scan");
    await triggers.expectScheduleAfterReload();
    await triggers.captureSchedule("e2e/screenshots/schedules/weekly.png");
    await triggers.captureScheduleAtPhoneWidth("e2e/screenshots/schedules/mobile.png");
    await triggers.switchToYaml();
    await triggers.expectYamlContains("frequency: weekly", "monday", "friday", "18:30");
  });
  await test.step("accept a real clock occurrence and show its source in Activity", async () => {
    await triggers.runScheduledOccurrence(hub.primaryApplication(), "periodic-scan");
  });
});
