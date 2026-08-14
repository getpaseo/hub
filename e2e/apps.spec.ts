import { expect } from "@playwright/test";
import { test } from "./app.js";
import { WORKING_CREDENTIALS } from "./helpers/apps.js";
import { SHOTS, type AppSetupSession } from "./helpers/app-evidence.js";
import type { PaseoHub } from "./helpers/hub.js";

// Every journey claims a second, genuinely pristine application beside the fixture's own.
test.describe.configure({ timeout: 150_000 });

const OPERATOR = {
  name: "App Operator",
  email: "app-operator@example.com",
  password: "app-operator-password",
};

async function openSetup(
  hub: PaseoHub,
  environmentApps?: readonly ("github" | "slack" | "discord")[],
): Promise<AppSetupSession> {
  return await hub.openAppSetup({
    account: OPERATOR,
    organizationName: "Acme",
    ...(environmentApps === undefined ? {} : { environmentApps }),
  });
}

test("a first account continues to app setup, and skipping it is durable", async ({ hub }) => {
  const session = await openSetup(hub);
  try {
    const { surface, page } = session;
    await surface.expectStatuses({
      GitHub: "Not set up",
      Slack: "Not set up",
      Discord: "Not set up",
    });
    // One job on arrival: GitHub is open, the other two wait.
    await surface.github.expectExpanded();
    await surface.slack.expectCollapsed();
    await surface.discord.expectCollapsed();
    await expect(surface.wayOut("Finish")).toHaveCount(0);
    await surface.accessible();
    await surface.shoot(SHOTS, "apps-01-chooser.desktop");

    await surface.leave("Do this later");
    // Business as usual once the transition completes: reloading never returns here.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await surface.shoot(SHOTS, "apps-14-skip-dashboard.desktop");
  } finally {
    await session.close();
  }
});

test("GitHub is verified, installed, and reported honestly at each boundary", async ({ hub }) => {
  const session = await openSetup(hub);
  try {
    const { surface, page, origin } = session;
    const github = surface.github;
    await github.expectExpanded();
    await surface.shoot(SHOTS, "apps-02-github-expanded.desktop");

    // The URLs the operator pastes into GitHub are generated from this Hub's own origin.
    await github.expectGeneratedUrl("Homepage URL", origin);
    await github.expectGeneratedUrl("Callback URL", `${origin}/api/integrations/github/callback`);
    await github.expectGeneratedUrl("Setup URL", `${origin}/api/integrations/github/setup`);
    await github.expectGeneratedUrl("Webhook URL", `${origin}/webhook`);
    await surface.shoot(SHOTS, "apps-18-copy-confirmed.desktop");

    // Nothing reaches the provider until every field is present.
    await github.save();
    await github.expectFieldError("Enter the App ID.");
    await github.expectStatus("Not set up");

    // A real server refusal: wrong credentials, a focused message, and the form still filled.
    await github.fill({ ...WORKING_CREDENTIALS.GitHub, "Private key": "wrong-key" });
    await github.save();
    await github.expectFocusedError(/GitHub didn't accept these credentials/u);
    await github.expectStatus("Not set up");
    expect(await github.value("App ID")).toBe("42");
    await surface.shoot(SHOTS, "apps-04-github-verify-failed.desktop");

    // Retry in place on the same button.
    await github.fill({ "Private key": WORKING_CREDENTIALS.GitHub["Private key"]! });
    await github.save();
    await github.expectFocusedResult("Paseo Hub · owned by acme-inc");
    // Verified is not green: credentials a provider accepted are not a working integration.
    await github.expectStatus("Verified");
    await surface.accessible();
    await surface.shoot(SHOTS, "apps-03-github-verified.desktop");

    await github.action("Install on GitHub").click();
    await github.expectFocusedResult("GitHub connected.");
    // The outcome is consumed, so a reload cannot replay it.
    await expect(page).not.toHaveURL(/[?&](?:app|result)=/u);
    await github.expectStatus("Connected");
    await github.expectResult("Connected to acme-inc.");
    // The webhook secret is proven by a signed delivery and nothing else.
    await github.expectResult("Waiting for an event");
    await surface.shoot(SHOTS, "apps-05-github-connected.desktop");

    // Once one arrives, the section says so — and only then.
    await session.seedSignedDelivery("github");
    await page.reload();
    await github.expand();
    await github.expectResult("Last event");
    await expect(github.status()).not.toContainText("Waiting for an event");
    await surface.shoot(SHOTS, "apps-05b-github-receiving-events.desktop");

    // The way out now reads as finishing.
    await expect(surface.wayOut("Finish")).toBeVisible();
    await expect(surface.wayOut("Do this later")).toHaveCount(0);
  } finally {
    await session.close();
  }
});

test("Discord is verified and added to a server from its own section", async ({ hub }) => {
  const session = await openSetup(hub);
  try {
    const { surface } = session;
    const discord = surface.discord;
    await discord.expand();
    await discord.expectGeneratedUrl(
      "Redirect",
      `${session.origin}/api/integrations/discord/callback`,
    );
    // Discord never posts to Hub, so a loopback address is genuinely fine.
    await expect(
      discord.body().getByText("Discord doesn't call this Hub, so a local address is fine here."),
    ).toBeVisible();
    await surface.shoot(SHOTS, "apps-09-discord-expanded.desktop");

    await discord.fillWorkingCredentials();
    await discord.save();
    await discord.expectFocusedResult("Paseo · application 900");
    await discord.expectStatus("Verified");
    await surface.shoot(SHOTS, "apps-10-discord-verified.desktop");

    await discord.action("Add to a Discord server").click();
    await discord.expectFocusedResult("Discord connected.");
    await expect(session.page).not.toHaveURL(/[?&](?:app|result)=/u);
    await discord.expectStatus("Connected");
    await discord.expectResult("Connected to Acme Guild.");
    // No event line at all: there is nothing inbound to wait for.
    await expect(discord.status()).not.toContainText("Waiting for an event");
    await surface.shoot(SHOTS, "apps-11-discord-connected.desktop");
  } finally {
    await session.close();
  }
});

test("Slack completes its HTTPS install before saving and activating the app", async ({ hub }) => {
  const session = await hub.openAppSetup({
    account: OPERATOR,
    organizationName: "Acme",
    https: true,
  });
  try {
    const { surface, page } = session;
    const slack = surface.slack;
    await slack.expand();

    // The manifest asks for the exact callback origin and grant Hub checks.
    const manifest = await slack.copiedManifest();
    expect(manifest).toContain(`${session.origin}/api/integrations/slack/callback`);
    expect(manifest).toContain(`${session.origin}/api/integrations/slack/events`);
    for (const scope of [
      "app_mentions:read",
      "channels:history",
      "chat:write",
      "files:read",
      "groups:history",
      "reactions:write",
      "users:read",
    ]) {
      expect(manifest).toContain(`- ${scope}`);
    }
    await surface.shoot(SHOTS, "apps-06-slack-expanded.desktop");

    await slack.fillWorkingCredentials();
    await slack.save();
    await expect(page.getByRole("heading", { name: "Install Paseo in Acme" })).toBeVisible();
    await page.getByRole("link", { name: "Accept installation" }).click();
    await slack.expectExpanded();
    await slack.expectFocusedResult("Slack connected.");
    await slack.expectStatus("Connected");
    await slack.expectResult("Connected to Acme.");
    await slack.expectResult("Waiting for an event");
    expect(await session.providerApplicationVersion("slack")).toBe(1);
    await expect(page).not.toHaveURL(/[?&](?:app|result)=/u);
    await surface.shoot(SHOTS, "apps-07-slack-connected.desktop");
  } finally {
    await session.close();
  }
});

test("Slack explains why setup is unavailable on plain HTTP", async ({ hub }) => {
  const session = await openSetup(hub);
  try {
    const slack = session.surface.slack;
    await slack.expand();
    await expect(
      slack.body().getByText("Slack requires a public HTTPS address.", { exact: false }),
    ).toBeVisible();
    await expect(slack.form().getByLabel("App ID", { exact: true })).toBeDisabled();
    await expect(slack.action("Save and continue to Slack")).toBeDisabled();
    await session.surface.shoot(SHOTS, "apps-08-slack-https-required.desktop");
  } finally {
    await session.close();
  }
});

test("sections open and close independently and keep what was typed", async ({ hub }) => {
  const session = await openSetup(hub);
  try {
    const { surface } = session;
    await surface.expectIndependentCollapse();

    await surface.github.fill({ "App ID": "42", "App slug": "paseo" });
    await surface.github.collapse();
    await surface.discord.expand();
    await surface.discord.fill({ "Application ID": "900" });
    await surface.github.expand();
    // A half-filled form survives being collapsed, and its neighbour's state is its own.
    expect(await surface.github.value("App ID")).toBe("42");
    expect(await surface.github.value("App slug")).toBe("paseo");
    expect(await surface.discord.value("Application ID")).toBe("900");

    // Toggling from the keyboard leaves focus on the control that was pressed.
    await surface.slack.collapse();
    await surface.slack.toggleFromKeyboard();
    await surface.slack.expectExpanded();
    await surface.slack.toggleFromKeyboard();
    await surface.slack.expectCollapsed();
    await surface.accessible();
  } finally {
    await session.close();
  }
});

test("an environment-managed app is read-only, connectable, and says so plainly", async ({
  hub,
}) => {
  const session = await openSetup(hub, ["github"]);
  try {
    const { surface } = session;
    const github = surface.github;
    await github.expectStatus("Managed by environment");
    await surface.leave("Do this later");
    await session.openManagement();
    await github.expand();
    await expect(
      github.body().getByText("Set by this Hub's environment. Change it there."),
    ).toBeVisible();
    // No form, no save, no way to replace what the environment owns.
    await expect(github.form()).toHaveCount(0);
    await expect(github.action("Verify and save")).toHaveCount(0);
    await expect(github.action("Replace credentials")).toHaveCount(0);
    // Identifiers are shown; secrets are not, and were never sent to the browser.
    await expect(github.body().getByText("42", { exact: true })).toBeVisible();
    await expect(github.body().getByText("fixture-private-key")).toHaveCount(0);
    await surface.shoot(SHOTS, "apps-16-instance-apps-environment.desktop");

    // Environment-managed is still connectable.
    await github.action("Install on GitHub").click();
    await github.expectStatus("Managed by environment");
    await github.expectResult("Connected to acme-inc.");
  } finally {
    await session.close();
  }
});

test("credentials can be replaced in place after they are saved", async ({ hub }) => {
  const session = await openSetup(hub);
  try {
    const { surface } = session;
    const github = surface.github;
    await github.fillWorkingCredentials();
    await github.save();
    await github.expectStatus("Verified");
    await surface.leave("Do this later");
    await session.openManagement();
    await github.expand();

    await github.action("Replace credentials").click();
    await expect(github.form().getByLabel("App ID", { exact: true })).toBeFocused();
    // Identifiers come back for checking; secrets never do.
    expect(await github.value("App ID")).toBe("42");
    expect(await github.value("Client secret")).toBe("");
    expect(await github.value("Private key")).toBe("");
    await expect(
      github
        .body()
        .getByText("Rotating secrets for the same app keeps your connections.", { exact: false }),
    ).toBeVisible();
    await surface.shoot(SHOTS, "apps-17-replace-credentials.desktop");

    await github.action("Cancel").click();
    await expect(github.action("Replace credentials")).toBeFocused();
    await expect(github.form()).toHaveCount(0);
    await github.expectStatus("Verified");
  } finally {
    await session.close();
  }
});

test("the operator finishes, then manages the same apps under Instance → Apps", async ({ hub }) => {
  const session = await hub.openAppSetup({
    account: OPERATOR,
    organizationName: "Acme",
    https: true,
  });
  try {
    const { surface, page } = session;
    await surface.github.fillWorkingCredentials();
    await surface.github.save();
    await surface.github.action("Install on GitHub").click();
    await surface.github.expectStatus("Connected");

    await surface.slack.expand();
    await surface.slack.fillWorkingCredentials();
    await surface.slack.save();
    await expect(page.getByRole("heading", { name: "Install Paseo in Acme" })).toBeVisible();
    await page.getByRole("link", { name: "Accept installation" }).click();
    await surface.slack.expectStatus("Connected");

    await surface.discord.expand();
    await surface.discord.fillWorkingCredentials();
    await surface.discord.save();
    await surface.discord.action("Add to a Discord server").click();
    await surface.discord.expectStatus("Connected");

    await surface.github.collapse();
    await surface.slack.collapse();
    await surface.discord.collapse();
    await surface.shoot(SHOTS, "apps-12-all-three-connected.desktop");

    await surface.leave("Finish");
    await surface.shoot(SHOTS, "apps-13-finish-dashboard.desktop");

    // Later management is the same three sections, with the state left behind.
    await page.getByRole("link", { name: "Apps", exact: true }).click();
    await surface.expectManagement();
    await surface.expectStatuses({
      GitHub: "Connected",
      Slack: "Connected",
      Discord: "Connected",
    });
    // Nothing is open on arrival here; there is no journey to lead.
    for (const section of surface.sections()) await section.expectCollapsed();
    await surface.accessible();
    await surface.shoot(SHOTS, "apps-15-instance-apps.desktop");
  } finally {
    await session.close();
  }
});

test("a member has no Apps surface at all", async ({ hub }) => {
  const session = await openSetup(hub);
  try {
    await session.surface.leave("Do this later");
    const member = await session.openMember({
      name: "Member",
      email: "app-member@example.com",
      password: "app-member-password",
    });
    try {
      await expect(member.page.getByRole("link", { name: "Apps", exact: true })).toHaveCount(0);
      await member.page.goto(`${session.origin}/apps`);
      // The route renders, the capability refuses: no credential status of any kind.
      await expect(member.page.getByText("We couldn't load your apps.")).toBeVisible();
      await expect(member.page.getByRole("form", { name: "Set up GitHub" })).toHaveCount(0);
      await expect(member.page.getByText("Not set up")).toHaveCount(0);
    } finally {
      await member.close();
    }
  } finally {
    await session.close();
  }
});
