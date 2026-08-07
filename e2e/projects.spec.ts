import { test } from "./app.js";
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
  "environments:\n  - name: runner\n    kind: docker\n    image: paseo/test\ntriggers: []";
const unresolvedConfiguration =
  "environments:\n  - name: runner\n    kind: daemon\n    daemon: missing-runner\n    cwd: /workspace\ntriggers: []";
/** Taller than the editor at any desktop viewport, so its last line starts out of sight. */
const longConfiguration = [
  "environments:",
  ...Array.from({ length: 40 }, (_, index) => [
    `  - name: runner-${String(index + 1)}`,
    "    kind: docker",
    "    image: paseo/test",
  ]).flat(),
  "triggers: []",
].join("\n");
const includeConfiguration = [
  "environments:",
  "  - name: runner",
  "    kind: daemon",
  "    daemon: editor-daemon",
  "    cwd: /workspace",
  "triggers:",
  "  - name: triage",
  "    on: manual.run",
  "    max_runtime: 1h",
  "    steps:",
  "      - id: only",
  "        environment: runner",
  "        max_runtime: 10m",
  "        idle_timeout: 1m",
  "        agent: { provider: claude }",
  "        prompt:",
  "          - include: triage/preamble.md",
].join("\n");

test("creates and archives projects through the organization project list", async ({
  hub,
  page,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.navigation.expectProjects();
  await app.projects.expectDefaultProject();
  await app.projects.create("Edge", "edge");
  await app.projects.archive("Edge");
});

test("switches projects without rendering stale project context", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.projects.create("Alpha", "alpha");
  await app.projects.create("Beta", "beta");
  await app.navigation.openProject("Alpha");
  await app.navigation.expectBreadcrumb("Acme", "Alpha", "Overview");
  await app.navigation.switchProject("Beta");
  await app.navigation.expectBreadcrumb("Acme", "Beta", "Overview");
});

test("keeps the active exact-SHA revision when the next GitHub revision is invalid", async ({
  hub,
  page,
  projectExternal,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.navigation.openOrganizationSection("Connections");
  await app.connections.connectGitHub();
  await app.navigation.openOrganizationSection("Projects");
  await app.navigation.openProject("Default");
  await app.configuration.useRepository("acme-inc/app");
  await projectExternal.setGitHubRevision(9001, "valid-sha", validConfiguration);
  await app.configuration.syncNow();
  await app.configuration.expectActiveRevision(1);
  await projectExternal.setGitHubRevision(
    9001,
    "invalid-sha",
    "environments: []\ntriggers: invalid",
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
  await app.navigation.openOrganizationSection("Connections");
  await app.connections.connectGitHub();
  await app.navigation.openOrganizationSection("Projects");
  await app.navigation.openProject("Default");
  await app.configuration.useRepository("acme-inc/app");
  await projectExternal.setGitHubRevision(9001, "valid-sha", validConfiguration);
  await app.configuration.syncNow();
  await app.configuration.expectActiveRevision(1);
  await app.configuration.switchToManual();
  await app.configuration.saveManualConfiguration(validConfiguration);
  await app.configuration.expectActiveRevision(3);
});

test("explains invalid manual configuration and allows a corrected retry", async ({
  hub,
  page,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.navigation.openProject("Default");
  await app.navigation.openProjectSection("Configuration");

  await app.configuration.saveManualConfiguration(validConfiguration);
  await app.configuration.expectActiveRevision(1);
  await app.configuration.saveManualConfiguration(unresolvedConfiguration);
  await app.configuration.expectValidationError(
    "Unresolved organization resources: missing-runner",
  );
  await app.configuration.expectActiveRevision(1);
  await app.configuration.saveManualConfiguration(validConfiguration);
  await app.configuration.expectConfigurationActivated(3);
  await app.configuration.expectActiveRevision(3);
});

test("scopes configuration activation feedback to its project", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.projects.create("Second", "second");
  await app.navigation.openProject("Second");
  await app.navigation.openProjectSection("Configuration");
  await app.navigation.switchProject("Default");

  await app.configuration.saveManualConfiguration(validConfiguration);
  await app.configuration.expectConfigurationActivated(1);
  await app.configuration.expectActiveRevision(1);
  await app.configuration.saveManualConfiguration(unresolvedConfiguration);
  await app.configuration.expectValidationError(
    "Unresolved organization resources: missing-runner",
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

  await app.configuration.saveManualConfiguration(validConfiguration);
  await app.configuration.expectConfigurationActivated(1);
  await app.configuration.expectReadOnlyEditor("environments:");
  await app.configuration.expectHighlightedYaml();

  await app.configuration.addPartial("triage/preamble.md", "Triage before labelling.");
  await app.configuration.openFile("hub.yml");
  await app.configuration.saveManualConfiguration(includeConfiguration);
  await app.configuration.expectConfigurationActivated(2);

  await app.navigation.openProjectSection("Overview");
  await app.navigation.openProjectSection("Configuration");
  await app.configuration.expectFiles(["hub.yml", "triage/preamble.md"]);
  await app.configuration.expectPartialContent("triage/preamble.md", "Triage before labelling.");
});

test("scrolls a long configuration down to its last line", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.navigation.openProject("Default");
  await app.navigation.openProjectSection("Configuration");
  await app.configuration.saveManualConfiguration(longConfiguration);
  await app.configuration.expectConfigurationActivated(1);

  await app.configuration.expectReadOnlyEditor("environments:");
  await app.configuration.expectLineOutOfSight("runner-40");
  await app.configuration.scrollEditorToEnd();
  await app.configuration.expectLineInSight("runner-40");
});

test("rejects a partial the configuration does not include", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedDaemonSlug("owner", "editor-daemon");
  await app.navigation.openProject("Default");
  await app.navigation.openProjectSection("Configuration");

  await app.configuration.saveManualConfiguration(validConfiguration);
  await app.configuration.expectActiveRevision(1);
  await app.configuration.addPartial("orphan.md", "Nothing includes this.");
  await app.configuration.save();

  await app.configuration.expectValidationError("not referenced by the configuration");
  await app.configuration.expectActiveRevision(1);
});

test("uses manual configuration without a GitHub deployment", async ({ hub }) => {
  await hub.proveManualConfigurationWithoutGitHub(owner, validConfiguration);
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

test("allows every project to use an organization GitHub repository", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.projects.create("Second", "second");
  await app.navigation.openOrganizationSection("Connections");
  await app.connections.connectGitHub();
  await app.navigation.openOrganizationSection("Projects");
  await app.navigation.openProject("Default");
  await app.configuration.useRepository("acme-inc/app");
  await app.navigation.switchProject("Second");
  await app.configuration.useRepository("acme-inc/app");
});

test("rejects inaccessible tenant slugs and keeps core project routes accessible", async ({
  hub,
  page,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.navigation.openProject("Default");
  await expectAccessibleProjectRoute(page);
  await app.navigation.visit("/o/unavailable/projects");
  await app.navigation.expectUnavailable("Organization");
  await app.navigation.visit("/o/unavailable/projects/missing/overview");
  await app.navigation.expectUnavailable("Project");
});

test("treats a deep-link URL as authority when the landing hint names another organization", async ({
  hub,
  page,
}) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.navigation.proveDeepLinkAuthorityWithMismatchedLandingHint("Acme", "Default");
});
