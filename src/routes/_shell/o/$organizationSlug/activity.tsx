import { createFileRoute } from "@tanstack/react-router";
import { ActivityPanel } from "../../../../activity/panel.js";
import { parseActivitySearch } from "../../../../activity/query-contract.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/activity")({
  validateSearch: parseActivitySearch,
  staticData: { breadcrumb: "Activity", projectSection: "activity", wide: true },
  component: ActivityPanel,
});
