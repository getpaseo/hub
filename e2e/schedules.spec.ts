import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

test("creates a twice-daily schedule, edits weekly recurrence, and preserves it through YAML and reload", async ({
  hub,
  page,
}) => {
  // Seven steps and ten save-and-reload round trips take about 17s alone on a
  // developer machine; on CI with two workers they overrun the default 30s.
  test.slow();
  await hub.signUpAs("owner", {
    name: "Schedule Owner",
    email: "schedule-owner@example.com",
    password: "schedule-owner-password",
  });
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  await hub.connectGitHub("owner");
  await hub.seedSlackConnection("owner", "company-slack", "Acme Slack");
  await hub.seedDiscordConnection("Acme", "company-discord");
  await hub.primaryApplication().query(
    `insert into integration_connections
       (provider, organization_id, slug, external_id, display_name, status, credentials, metadata, workspace_id)
     select 'notion', id, 'company-notion', 'ws-notion-sched:bot-1', 'Acme Notion', 'active',
            '{"apiToken":"ntn_sched_token"}'::jsonb,
            '{"mode":"internal","workspaceName":"Acme Notion"}'::jsonb,
            'ws-notion-sched'
     from organization
     where name = 'Acme'
     limit 1`,
  );
  const triggers = new OrganizationTriggers(page);
  await test.step("create a twice-daily schedule using normal execution settings", async () => {
    await triggers.open();
    await triggers.startNew();
    await triggers.configureSchedule(daemon);
    await triggers.grantScheduledIntegrationTools();
    await triggers.captureSchedule("e2e/screenshots/schedules/daily.png");
    await triggers.switchToYaml();
    await triggers.expectYamlContains(
      "schedule.tick:",
      "FREQ=DAILY",
      "Europe/Berlin",
      "thinkingOptionId: low",
      "connection: acme-inc-github",
      "acme-inc/hub",
      "connection: company-slack",
      "connection: company-discord",
      "connection: company-notion",
      "248104cd-477e-80af-bc30-000bd28de8f9",
      "CALLOWED",
      "123456789012345678",
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
    await triggers.expectScheduledIntegrationTools();
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
  await test.step("Every hour means hourly without a second interval field", async () => {
    await triggers.open();
    await triggers.openTrigger("periodic-scan");
    await triggers.setSimpleSchedule("Every hour");
    await triggers.save("periodic-scan");
    await triggers.openTrigger("periodic-scan");
    await triggers.expectHourlyAfterReload();
    await triggers.captureScheduleDetail("e2e/screenshots/schedules/hourly.png");
  });
  await test.step("custom intervals from YAML use the custom field and survive reload", async () => {
    await triggers.useAdvancedScheduleRule("FREQ=MINUTELY;INTERVAL=90");
    await triggers.save("periodic-scan");
    await triggers.openTrigger("periodic-scan");
    await triggers.expectAdvancedScheduleRuleAfterReload("FREQ=MINUTELY;INTERVAL=90");
    await triggers.captureCustomSchedule("e2e/screenshots/schedules/interval.png");
    await triggers.save("periodic-scan");
    await triggers.openTrigger("periodic-scan");
    await triggers.switchToYaml();
    await triggers.expectYamlContains("FREQ=MINUTELY;INTERVAL=90", "Include links.");
  });
  await test.step("calendar rules from YAML use the custom field", async () => {
    await triggers.open();
    await triggers.openTrigger("periodic-scan");
    await triggers.useAdvancedScheduleRule("FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17");
    await triggers.save("periodic-scan");
    await triggers.openTrigger("periodic-scan");
    await triggers.expectAdvancedScheduleRuleAfterReload("FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17");
    await triggers.captureCustomSchedule("e2e/screenshots/schedules/monthly.png");
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
