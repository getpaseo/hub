import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";
import { RoutingAudit } from "./helpers/projects/routing.js";

test.use({ providerScenario: "slack-only" });

const owner = {
  name: "Alice",
  email: "alice-routing-audit@example.com",
  password: "alice-routing-audit-password",
};

test("shows safe stored trigger rejection evidence for an unrouted event", async ({
  hub,
  page,
}) => {
  const app = projectApp(page);
  const audit = new RoutingAudit(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedUnroutedRoutingDecision("owner");
  await hub.expectRoutingAuditPersistenceSafe();
  await app.navigation.openOrganizationSection("Connections");

  await audit.expectKnownUnroutedReason("The sender is not allowed for this trigger.");
  await audit.expandTriggerDecisions();
  await audit.expectNoSensitiveRoutingEvidence();
});
