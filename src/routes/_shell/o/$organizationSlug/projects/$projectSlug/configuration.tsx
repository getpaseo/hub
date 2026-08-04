import { createFileRoute } from "@tanstack/react-router";
import { ProjectConfigurationPanel } from "../../../../../../projects/panels.js";
export const Route = createFileRoute(
  "/_shell/o/$organizationSlug/projects/$projectSlug/configuration",
)({ component: ProjectConfigurationPanel });
