import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/open/executions/$executionId")({
  validateSearch: (search: Record<string, unknown>): { view?: "run" } =>
    search["view"] === "run" ? { view: "run" } : {},
  server: {
    handlers: {
      GET: async ({ request }) => {
        const id = new URL(request.url).pathname.split("/")[3] ?? "";
        return (await getApplication()).operations.handleExecutionLauncher(request, id);
      },
    },
  },
});
