import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/o/$organizationSlug/triggers")({
  staticData: { breadcrumb: "Triggers" },
  component: Outlet,
});
