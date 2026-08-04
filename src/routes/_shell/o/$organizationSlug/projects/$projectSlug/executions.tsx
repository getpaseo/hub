import { createFileRoute } from "@tanstack/react-router";
import { ProjectExecutionsPanel } from "../../../../../../projects/panels.js";
export const Route = createFileRoute(
  "/_shell/o/$organizationSlug/projects/$projectSlug/executions",
)({ component: ProjectExecutionsPanel });
