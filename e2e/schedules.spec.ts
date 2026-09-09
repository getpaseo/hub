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
      "FREQ=DAILY",
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
    await triggers.expectYamlContains(
      "FREQ=WEEKLY",
      "BYDAY=MO,FR",
      "BYHOUR=8,18",
      "BYMINUTE=15,30",
    );
  });
  await test.step("accept a real clock occurrence and show its source in Activity", async () => {
    await triggers.runScheduledOccurrence(hub.primaryApplication(), "periodic-scan");
  });
  await test.step("edit to hourly and anchored 90-minute repeats, then save and reload", async () => {
    await triggers.open();
    await triggers.openTrigger("periodic-scan");
    await triggers.setScheduleInterval("Every hour", 1);
    await triggers.save("periodic-scan");
    await triggers.openTrigger("periodic-scan");
    await triggers.expectScheduleIntervalAfterReload("Every hour", 1);
    await triggers.captureScheduleDetail("e2e/screenshots/schedules/hourly.png");
    await triggers.setScheduleInterval("Every minute", 90);
    await triggers.save("periodic-scan");
    await triggers.openTrigger("periodic-scan");
    await triggers.expectScheduleIntervalAfterReload("Every minute", 90);
    await triggers.captureScheduleDetail("e2e/screenshots/schedules/interval.png");
    await triggers.switchToYaml();
    await triggers.expectYamlContains("FREQ=MINUTELY;INTERVAL=90");
  });
  await test.step("edit to the last Friday each month and reload its controls", async () => {
    await triggers.open();
    await triggers.openTrigger("periodic-scan");
    await triggers.setScheduleToLastFriday();
    await triggers.save("periodic-scan");
    await triggers.openTrigger("periodic-scan");
    await triggers.expectLastFridayAfterReload();
    await triggers.captureScheduleDetail("e2e/screenshots/schedules/monthly.png");
    await triggers.switchToYaml();
    await triggers.expectYamlContains("FREQ=MONTHLY;BYDAY=-1FR");
  });
  await test.step("preserve advanced rules while editing execution settings", async () => {
    await triggers.open();
    await triggers.openTrigger("periodic-scan");
    await triggers.useAdvancedScheduleRule("FREQ=HOURLY;BYMINUTE=15,45;COUNT=10");
    await triggers.save("periodic-scan");
    await triggers.openTrigger("periodic-scan");
    await triggers.expectAdvancedScheduleRuleAfterReload("FREQ=HOURLY;BYMINUTE=15,45;COUNT=10");
    await triggers.save("periodic-scan");
    await triggers.openTrigger("periodic-scan");
    await triggers.switchToYaml();
    await triggers.expectYamlContains("FREQ=HOURLY;BYMINUTE=15,45;COUNT=10", "Include links.");
  });
});
