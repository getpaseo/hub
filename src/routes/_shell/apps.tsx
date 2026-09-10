import { createFileRoute } from "@tanstack/react-router";
import { AppsPanel } from "../../provider-applications/panel.js";

export const Route = createFileRoute("/_shell/apps")({
  staticData: { breadcrumb: "Apps", instance: true },
  component: AppsPanel,
});
