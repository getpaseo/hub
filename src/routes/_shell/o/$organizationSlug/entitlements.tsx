import { createFileRoute } from "@tanstack/react-router";
import { OrganizationEntitlementsPanel } from "../../../../entitlements/panel.js";
export const Route = createFileRoute("/_shell/o/$organizationSlug/entitlements")({
  component: OrganizationEntitlementsPanel,
});
