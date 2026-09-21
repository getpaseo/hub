import { createFileRoute } from "@tanstack/react-router";
import { HomePanel } from "../../../../home/panel.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/home")({
  staticData: { breadcrumb: "Home" },
  component: HomePanel,
});
