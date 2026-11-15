import { createFileRoute } from "@tanstack/react-router";
import { OrganizationIntegrationsPanel } from "../../../../projects/panels.js";
export const Route = createFileRoute("/_shell/o/$organizationSlug/integrations")({
  staticData: { breadcrumb: "Integrations" },
  component: OrganizationIntegrationsPanel,
});
