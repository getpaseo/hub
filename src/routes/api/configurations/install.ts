import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/api/configurations/install")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await getApplication()).operations.handleConfigurationInstall(request),
    },
  },
});
