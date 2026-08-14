import { expect } from "@playwright/test";
import { test } from "./app.js";
import { WORKING_CREDENTIALS } from "./helpers/apps.js";
import { SHOTS } from "./helpers/app-evidence.js";

test.describe.configure({ timeout: 240_000 });

const OPERATOR = {
  name: "Mobile Operator",
  email: "mobile-operator@example.com",
  password: "mobile-operator-password",
};

test("a phone operator can skip app setup and reach their dashboard", async ({ hub }) => {
  const organizationName = "Harbor Cooperative";
  const session = await hub.openAppSetup({
    account: {
      name: "Harbor Operator",
      email: "harbor-operator@example.com",
      password: "harbor-operator-password",
    },
    organizationName,
  });
  try {
    await session.surface.leave("Do this later");
    await expect(
      session.page.getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible();
    await expect(
      session.page
        .getByRole("navigation", { name: "Breadcrumb", exact: true })
        .getByText(organizationName, { exact: true }),
    ).toBeVisible();
    await session.surface.shoot(SHOTS, "apps-14-skip-dashboard.mobile");
  } finally {
    await session.close();
  }
});

test("the whole app setup journey completes at phone width", async ({ hub }) => {
  const session = await hub.openAppSetup({
    account: OPERATOR,
    organizationName: "Acme",
    https: true,
  });
  try {
    const { surface, page } = session;
    const github = surface.github;
    await surface.expectOnboarding();
    await github.expectExpanded();
    await github.collapse();
    await surface.shoot(SHOTS, "apps-01-chooser.mobile");
    await github.expand();

    // Sections stack, and each header is a touch target rather than a hover affordance.
    for (const section of surface.sections()) {
      const box = await section.header().boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      await section.expectCompactHeaderLayout();
    }

    // A generated URL and its copy button share a row without pushing the layout sideways.
    const document = await page.evaluate(() => ({
      scrollWidth: window.document.documentElement.scrollWidth,
      clientWidth: window.document.documentElement.clientWidth,
    }));
    expect(document.scrollWidth).toBeLessThanOrEqual(document.clientWidth + 1);
    await surface.shoot(SHOTS, "apps-02-github-expanded.mobile");
    await github.expectGeneratedUrl(
      "Callback URL",
      `${session.origin}/api/integrations/github/callback`,
    );
    await surface.shoot(SHOTS, "apps-18-copy-confirmed.mobile");

    await github.fill({ ...WORKING_CREDENTIALS.GitHub, "Private key": "wrong-key" });
    await github.save();
    await github.expectFocusedError(/GitHub didn't accept these credentials/u);
    await surface.shoot(SHOTS, "apps-04-github-verify-failed.mobile");
    await github.fill({ "Private key": WORKING_CREDENTIALS.GitHub["Private key"]! });
    await github.save();
    await github.expectFocusedResult("Paseo Hub · owned by acme-inc");
    await github.expectStatus("Verified");
    await surface.shoot(SHOTS, "apps-03-github-verified.mobile");

    await github.action("Install on GitHub").click();
    await github.expectStatus("Connected");
    await github.expectResult("Connected to acme-inc.");
    await github.expectResult("Waiting for an event");
    await surface.accessible();
    await surface.shoot(SHOTS, "apps-05-github-connected.mobile");

    await github.collapse();
    await surface.slack.expand();
    const slackDocument = await page.evaluate(() => ({
      scrollWidth: window.document.documentElement.scrollWidth,
      clientWidth: window.document.documentElement.clientWidth,
    }));
    expect(slackDocument.scrollWidth).toBeLessThanOrEqual(slackDocument.clientWidth + 1);
    await surface.shoot(SHOTS, "apps-06-slack-expanded.mobile");
    await surface.slack.fillWorkingCredentials();
    await surface.slack.save();
    await expect(page.getByRole("heading", { name: "Install Paseo in Acme" })).toBeVisible();
    await page.getByRole("link", { name: "Accept installation" }).click();
    await surface.slack.expectStatus("Connected");
    await surface.slack.expectResult("Connected to Acme.");
    await surface.shoot(SHOTS, "apps-07-slack-connected.mobile");

    await surface.slack.collapse();
    await surface.discord.expand();
    await surface.shoot(SHOTS, "apps-09-discord-expanded.mobile");
    await surface.discord.fillWorkingCredentials();
    await surface.discord.save();
    await surface.discord.expectStatus("Verified");
    await surface.shoot(SHOTS, "apps-10-discord-verified.mobile");
    await surface.discord.action("Add to a Discord server").click();
    await surface.discord.expectStatus("Connected");
    await surface.discord.expectResult("Connected to Acme Guild.");
    await surface.shoot(SHOTS, "apps-11-discord-connected.mobile");

    // The way out is a full-width button pinned to the bottom of a phone screen.
    const finish = surface.wayOut("Finish");
    await expect(finish).toBeInViewport();
    await surface.discord.collapse();
    await surface.shoot(SHOTS, "apps-12-all-three-connected.mobile");

    await surface.leave("Finish");
    await surface.shoot(SHOTS, "apps-13-finish-dashboard.mobile");
  } finally {
    await session.close();
  }
});

test("Slack and Discord read correctly on a phone", async ({ hub }) => {
  const session = await hub.openAppSetup({ account: OPERATOR, organizationName: "Acme" });
  try {
    const { surface } = session;
    await surface.slack.expand();
    await surface.slack.expectHttpsBlocked();
    await surface.shoot(SHOTS, "apps-08-slack-https-required.mobile");
    await surface.slack.collapse();

    await surface.discord.expand();
    await surface.discord.fillWorkingCredentials();
    await surface.discord.save();
    await surface.discord.expectStatus("Verified");
    await surface.discord.action("Add to a Discord server").click();
    await surface.discord.expectStatus("Connected");

    // Until the operator leaves app setup, every URL is app setup — including /apps.
    await surface.leave("Finish");
    await session.openManagement();
    await surface.expectStatuses({
      GitHub: "Not set up",
      Slack: "Not set up",
      Discord: "Connected",
    });
    await surface.shoot(SHOTS, "apps-15-instance-apps.mobile");
  } finally {
    await session.close();
  }
});

test("mobile evidence covers skipping and later environment-managed apps", async ({ hub }) => {
  const skipped = await hub.openAppSetup({ account: OPERATOR, organizationName: "Acme" });
  try {
    await skipped.surface.leave("Do this later");
  } finally {
    await skipped.close();
  }

  const managed = await hub.openAppSetup({
    account: OPERATOR,
    organizationName: "Acme",
    environmentApps: ["github"],
  });
  try {
    await managed.surface.leave("Do this later");
    await managed.openManagement();
    await managed.surface.github.expand();
    await expect(managed.surface.github.form()).toHaveCount(0);
    await managed.surface.shoot(SHOTS, "apps-16-instance-apps-environment.mobile");
  } finally {
    await managed.close();
  }
});

test("mobile replacement keeps secrets empty in Instance → Apps", async ({ hub }) => {
  const session = await hub.openAppSetup({ account: OPERATOR, organizationName: "Acme" });
  try {
    await session.surface.github.fillWorkingCredentials();
    await session.surface.github.save();
    await session.surface.leave("Do this later");
    await session.openManagement();
    await session.surface.github.expand();
    await session.surface.github.action("Replace credentials").click();
    expect(await session.surface.github.value("Private key")).toBe("");
    await session.surface.shoot(SHOTS, "apps-17-replace-credentials.mobile");
  } finally {
    await session.close();
  }
});
