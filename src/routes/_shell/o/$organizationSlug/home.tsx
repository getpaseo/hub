import { createFileRoute } from "@tanstack/react-router";
import { HomePanel } from "../../../../home/panel.js";
import { parseHomeSearch } from "../../../../home/range.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/home")({
  staticData: { breadcrumb: "Home" },
  validateSearch: parseHomeSearch,
  component: HomePanel,
});
