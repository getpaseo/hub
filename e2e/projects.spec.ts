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
