import { expect } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";

const owner = {
  name: "Amara",
  email: "amara-entitlements@example.com",
  password: "amara-entitlements-password",
};
const secondMember = "bela-entitlements@example.com";
const thirdMember = "cyrus-entitlements@example.com";
const meterOwner = {
  name: "Deo",
  email: "deo-entitlements@example.com",
  password: "deo-entitlements-password",
};

const SLICE_1_DIR = "e2e/screenshots/slice-1";
const SLICE_2_DIR = "e2e/screenshots/slice-2";
const SLICE_3_DIR = "e2e/screenshots/slice-3";

test("shows the unlimited default entitlements for a newly provisioned organization", async ({
  hub,
  page,
}) => {
  await test.step("sign up and land in a new organization", async () => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await page.screenshot({
      path: `${SLICE_1_DIR}/01-new-organization.png`,
      fullPage: true,
    });
  });

  await test.step("open the entitlements page and see the unlimited defaults", async () => {
    await hub.expectEntitlements("owner");
    await page.screenshot({
      path: `${SLICE_1_DIR}/02-entitlements-unlimited-defaults.png`,
      fullPage: true,
    });
  });
});

test("an owner caps seats, a blocked invite explains itself, and the audit trail records who and why", async ({
  hub,
  page,
}) => {
  const reason = "Founding-team seat cap for the private beta";

  await test.step("sign up and create an organization", async () => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
  });

  await test.step("cap seats at 2 with a required reason", async () => {
    await hub.openSeatOverrideEditor("owner", { max: 2, reason });
    await page.screenshot({ path: `${SLICE_2_DIR}/01-override-editor.png`, fullPage: true });
    await hub.saveSeatOverride("owner", 2);
  });

  await test.step("invite the second member, filling the two-seat cap", async () => {
    await hub.inviteMember("owner", secondMember, "member");
  });

  await test.step("a third invite is refused with a message that names the limit", async () => {
    await hub.expectInviteRefusedBySeatLimit("owner", thirdMember, { limit: 2, current: 2 });
    await page.screenshot({ path: `${SLICE_2_DIR}/02-invite-refused.png`, fullPage: true });
  });

  await test.step("the audit trail records who capped seats and why", async () => {
    await hub.expectEntitlementsAudit("owner", { actor: owner.name, reason });
    await page.screenshot({ path: `${SLICE_2_DIR}/03-audit-trail.png`, fullPage: true });
  });
});

test.describe("metered usage", () => {
  test.describe.configure({ timeout: 120_000 });

  test("caps executions per month, denies the second run, and shows usage on the page", async ({
    hub,
    page,
  }) => {
    const reason = "Trial cap on monthly executions";
    const app = projectApp(page);

    await test.step("sign up, create an organization, and register a daemon", async () => {
      await hub.signUpAs("owner", meterOwner);
      await hub.createOrganization("owner", "Acme");
      await hub.startDaemonRegistration("owner");
      const daemonId = await hub.approveDaemon("owner", "Slice Three Runner");
      await hub.setDaemonSlug(daemonId, "slice-three-runner");
    });

    await test.step("cap executions this month at 1 with a required reason", async () => {
      await hub.openMeterOverrideEditor("owner", { limit: 1, reason });
      await page.screenshot({ path: `${SLICE_3_DIR}/01-override-editor.png`, fullPage: true });
      await hub.saveMeterOverride("owner", 1);
    });

    await test.step("install a manual deploy trigger against the registered daemon", async () => {
      await app.navigation.openOrganizationSection("Projects");
      await app.navigation.openProject("Default");
      await app.navigation.openProjectSection("Configuration");
      await app.configuration.switchToManual();
      await app.configuration.saveManualConfiguration(
        [
          "environments:",
          "  - name: slice-three-runner",
          "    kind: daemon",
          "    daemon: slice-three-runner",
          "    cwd: /workspace",
          "triggers:",
          "  - name: deploy",
          "    on: manual.run",
          "    max_runtime: 1h",
          "    filters:",
          "      from_users: [alice]",
          "    steps:",
          "      - id: deploy",
          "        environment: slice-three-runner",
          "        max_runtime: 10m",
          "        idle_timeout: 1m",
          "        agent:",
          "          provider: opencode",
          "        prompt:",
          "          - text: '${{ paseo.prompt }}'",
        ].join("\n"),
      );
      await app.configuration.expectActiveRevision(1);
    });

    const runApiKey = await hub.createRunApiKey("owner");

    await test.step("run one execution: allowed", async () => {
      const first = await hub.runManualInput({
        rawInput: "run it",
        deliveryKey: "slice-3-run-1",
        apiKey: runApiKey,
      });
      expect(first.workflowStatus).toBe("running");
    });

    await test.step("a second execution in the same month is denied by the meter", async () => {
      const second = await hub.runManualInput({
        rawInput: "run it again",
        deliveryKey: "slice-3-run-2",
        apiKey: runApiKey,
      });
      expect(second.workflowStatus).toBe("failed");
    });

    await test.step("the denied run is visible in project activity", async () => {
      await app.navigation.openOrganizationSection("Projects");
      await app.navigation.openProject("Default");
      await app.navigation.openProjectSection("Activity");
      const activity = page.getByRole("table", { name: "Project activity" });
      await expect(activity).toContainText("failed");
      await page.screenshot({ path: `${SLICE_3_DIR}/02-execution-denied.png`, fullPage: true });
    });

    await test.step("the entitlements page shows 1 of 1 executions used", async () => {
      await hub.expectMeterUsage("owner", { used: 1, limit: 1 });
      await page.screenshot({ path: `${SLICE_3_DIR}/03-usage-shown.png`, fullPage: true });
    });
  });
});
