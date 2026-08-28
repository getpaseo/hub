import { test } from "./app.js";
import { expect } from "@playwright/test";
import { expectAccessibleProjectRoute } from "./helpers/projects/assertions.js";
import {
  expectNoProjectActivity,
  expectProjectActivity,
  expectRunSteps,
  openProjectRun,
} from "./helpers/projects/activity.js";
import { projectApp } from "./helpers/projects/index.js";

const owner = {
  name: "Alice",
  email: "alice-projects@example.com",
  password: "alice-projects-password",
};
const validConfiguration =
  "environments:\n  runner:\n    kind: daemon\n    daemon: editor-daemon\n    cwd: /workspace\nagents: {}";
const unresolvedConfiguration =
  "environments:\n  runner:\n    kind: daemon\n    daemon: missing-runner\n    cwd: /workspace\nagents: {}";
const includeResources = [
  "environments:",
  "  runner:",
  "    kind: daemon",
  "    daemon: editor-daemon",
  "    cwd: /workspace",
  "agents: {}",
].join("\n");
const includeWorkflow = [
  "name: triage",
  "on: manual.run",
  "max_runtime: 1h",
  "steps:",
  "  - id: only",
  "    environment: runner",
  "    max_runtime: 10m",
  "    idle_timeout: 1m",
  "    agent: { provider: claude }",
  "    prompt:",
  "      - include: partials/triage/preamble.md",
].join("\n");

const bundle = (hub: string, files: readonly { path: string; content: string }[] = []) => [
  { path: ".paseo/hub.yml", content: hub },
  {
    path: ".paseo/workflows/baseline.yml",
    content:
      "name: baseline\non: manual.run\nmax_runtime: 1h\nsteps:\n  - id: work\n    environment: runner\n    max_runtime: 10m\n    idle_timeout: 1m\n    agent: { provider: test }\n    prompt: [{ text: baseline }]",
  },
  ...files,
];

test("creates, switches, and archives projects without stale project context", async ({
  hub,
  page,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.navigation.expectProjects();
  await app.projects.expectDefaultProject();
  await app.projects.create("Alpha", "alpha");
  await app.projects.create("Beta", "beta");
  await app.navigation.openProject("Alpha");
  await app.navigation.expectBreadcrumb("Acme", "Alpha", "Overview");
  await app.navigation.switchProject("Beta");
  await app.navigation.expectBreadcrumb("Acme", "Beta", "Overview");
  await app.navigation.leaveProject();
  await app.projects.archive("Alpha");
});

test("keeps the active exact-SHA revision when the next GitHub revision is invalid", async ({
  hub,
  page,
  projectExternal,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedDaemonSlug("owner", "editor-daemon");
  await app.navigation.openOrganizationSection("Connections");
  await app.connections.connectGitHub();
  await app.navigation.openOrganizationSection("Projects");
  await app.navigation.openProject("Default");
  await app.configuration.useRepository("acme-inc/app");
  await app.configuration.expectSourceControlsClearOfTheEditor();
  await projectExternal.setGitHubRevision(9001, "valid-sha", bundle(validConfiguration));
  await app.configuration.syncNow();
  await app.configuration.expectActiveRevision(1);
  await projectExternal.setGitHubRevision(
    9001,
    "invalid-sha",
    bundle("environments: []\nagents: {}"),
  );
  await projectExternal.pushGitHubDefaultBranch(9001, "invalid-sha", "invalid-delivery");
  await app.configuration.syncNow();
  await app.configuration.expectInvalidPreserved(1);
});

test("switches a project's configuration source between GitHub and manual", async ({
  hub,
  page,
  projectExternal,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedDaemonSlug("owner", "editor-daemon");
  await app.projects.create("Second", "second");
  await app.navigation.openOrganizationSection("Connections");
  await app.connections.connectGitHub();
  await app.navigation.openOrganizationSection("Projects");
  await app.navigation.openProject("Default");
  await app.configuration.useRepository("acme-inc/app");
  await projectExternal.setGitHubRevision(9001, "valid-sha", bundle(validConfiguration));
  await app.configuration.syncNow();
  await app.configuration.expectActiveRevision(1);
  await app.navigation.switchProject("Second");
  await app.configuration.useRepository("acme-inc/app");
  await app.navigation.switchProject("Default");
  await app.configuration.switchToManual();
  await app.configuration.saveManualConfiguration(validConfiguration);
  await app.configuration.expectActiveRevision(3);
});

test("a save owns its activation, so the next edit never races the remount", async ({
  hub,
  page,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedDaemonSlug("owner", "editor-daemon");
  await app.navigation.openProject("Default");
  await app.navigation.openProjectSection("Configuration");
  await app.configuration.switchToManual();

  // The activation lands, then the refresh that remounts the workbench takes far longer than any
  // fixed wait a later command could reasonably hold. Saving has to absorb that itself.
  await app.configuration.delayRefreshAfterNextSave(7_000);
  await app.configuration.saveManualConfiguration(validConfiguration);
  await app.configuration.addWorkflow(
    "second.yml",
    [
      "name: second",
      "on: manual.run",
      "max_runtime: 1h",
      "steps:",
      "  - id: work",
      "    environment: runner",
      "    max_runtime: 10m",
      "    idle_timeout: 1m",
      "    agent: { provider: test }",
      "    prompt: [{ text: second }]",
    ].join("\n"),
  );
  await app.configuration.save();

  // The second workflow was written into the mount that survived, not one that was replaced
  // underneath it.
  await app.configuration.expectActiveRevision(2);
  await expect(
    page
      .getByRole("list", { name: "Configuration files" })
      .getByRole("button", { name: ".paseo/workflows/second.yml", exact: true }),
  ).toBeVisible();

  await app.configuration.saveManualConfiguration(unresolvedConfiguration);
  await app.configuration.expectValidationError(
    '"missing-runner" does not match any daemon (connected: editor-daemon)',
  );
  await app.configuration.expectActiveRevision(2);
  await app.configuration.saveManualConfiguration(validConfiguration);
  await app.configuration.expectConfigurationActivated(4);
  await app.configuration.expectActiveRevision(4);
});

test("keeps GitHub-authored partials openable after switching to manual", async ({
  hub,
  page,
  projectExternal,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedDaemonSlug("owner", "editor-daemon");
  await app.navigation.openOrganizationSection("Connections");
  await app.connections.connectGitHub();
  await app.navigation.openOrganizationSection("Projects");
  await app.navigation.openProject("Default");
  await app.configuration.useRepository("acme-inc/app");
  await projectExternal.setGitHubRevision(
    9001,
    "partial-sha",
    bundle(includeResources, [
      { path: ".paseo/workflows/triage.yml", content: includeWorkflow },
      {
        path: ".paseo/workflows/partials/triage/preamble.md",
        content: "Triage before labelling.",
      },
    ]),
  );
  await app.configuration.syncNow();
  await app.configuration.expectActiveRevision(1);
  await app.configuration.expectFiles([
    ".paseo/hub.yml",
    ".paseo/workflows/baseline.yml",
    ".paseo/workflows/partials/triage/preamble.md",
    ".paseo/workflows/triage.yml",
  ]);
  await app.configuration.expectPartialContent(
    ".paseo/workflows/partials/triage/preamble.md",
    "Triage before labelling.",
  );

  await app.configuration.switchToManual();

  await app.configuration.expectActiveRevision(2);
  await app.configuration.expectFiles([
    ".paseo/hub.yml",
    ".paseo/workflows/baseline.yml",
    ".paseo/workflows/partials/triage/preamble.md",
    ".paseo/workflows/triage.yml",
  ]);
  await app.configuration.expectPartialContent(
    ".paseo/workflows/partials/triage/preamble.md",
    "Triage before labelling.",
  );
  await app.configuration.saveUnmodified();
  await app.configuration.expectConfigurationActivated(3);
});

test("scopes configuration activation feedback to its project", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedDaemonSlug("owner", "editor-daemon");
  await app.projects.create("Second", "second");
  await app.navigation.openProject("Second");
  await app.navigation.openProjectSection("Configuration");
  await app.navigation.switchProject("Default");

  await app.configuration.saveManualConfiguration(validConfiguration);
  await app.configuration.expectConfigurationActivated(1);
  await app.configuration.expectActiveRevision(1);
  await app.configuration.saveManualConfiguration(unresolvedConfiguration);
  await app.configuration.expectValidationError(
    '"missing-runner" does not match any daemon (connected: editor-daemon)',
  );
  await app.navigation.switchProject("Second");
  await app.configuration.expectNoPriorProjectFeedback(1, "missing-runner");
});

test("edits configuration and prompt partials in the editor", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedDaemonSlug("owner", "editor-daemon");
  await app.navigation.openProject("Default");
  await app.navigation.openProjectSection("Configuration");

  await app.configuration.saveManualConfiguration(includeResources);
  await app.configuration.expectConfigurationActivated(1);
  await app.configuration.expectReadOnlyEditor("environments:");
  await app.configuration.expectHighlightedYaml();

  await app.configuration.addPartial("triage/preamble.md", "Triage before labelling.");
  await app.configuration.addWorkflow("triage.yml", includeWorkflow);
  await app.configuration.save();
  await app.configuration.expectConfigurationActivated(2);

  await app.navigation.openProjectSection("Overview");
  await app.navigation.openProjectSection("Configuration");
  await app.configuration.expectFiles([
    ".paseo/hub.yml",
    ".paseo/workflows/baseline.yml",
    ".paseo/workflows/partials/triage/preamble.md",
    ".paseo/workflows/triage.yml",
  ]);
  await app.configuration.expectPartialContent(
    ".paseo/workflows/partials/triage/preamble.md",
    "Triage before labelling.",
  );
  await app.configuration.removeWorkflow(".paseo/workflows/triage.yml");
  await app.configuration.removePartial(".paseo/workflows/partials/triage/preamble.md");
  await app.configuration.save();
  await app.configuration.expectConfigurationActivated(3);
  await app.configuration.expectFiles([".paseo/hub.yml", ".paseo/workflows/baseline.yml"]);

  await app.configuration.addPartial("orphan.md", "Nothing includes this.");
  await app.configuration.save();

  await app.configuration.expectValidationError("not referenced by any workflow");
  await app.configuration.expectActiveRevision(3);
});

test("isolates durable activity and step detail by project", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.projects.create("Second", "second");
  await hub.seedProjectHistory("owner", "default");
  await app.navigation.openProject("Default");
  await app.navigation.openProjectSection("Activity");
  await expectProjectActivity(page);
  await openProjectRun(page, "Browser history");
  await expectRunSteps(page, ["history", "succeeded"]);
  await app.navigation.switchProject("Second");
  await app.navigation.openProjectSection("Activity");
  await expectNoProjectActivity(page);
});

test("keeps project routes accessible and treats the deep-link URL as authority", async ({
  hub,
  page,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");

  await page.goto(`${hub.primaryApplication().origin}/projects/default/activity`);
  await expect(page).toHaveURL(/\/o\/acme-[a-f0-9]{8}\/projects\/default\/activity\/?$/u);
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();

  await app.navigation.leaveProject();
  await app.navigation.openProject("Default");
  await expectAccessibleProjectRoute(page);
  await app.navigation.leaveProject();
  await app.navigation.proveDeepLinkAuthorityWithMismatchedLandingHint("Acme", "Default");
  await app.navigation.visit("/o/unavailable/projects");
  await app.navigation.expectUnavailable("Organization");
  await app.navigation.visit("/o/unavailable/projects/missing/overview");
  await app.navigation.expectUnavailable("Project");
});
