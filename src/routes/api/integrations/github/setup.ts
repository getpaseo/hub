import { createFileRoute } from "@tanstack/react-router";
import { handleConnections } from "../../../../server/runtime.js";

export const Route = createFileRoute("/api/integrations/github/setup")({
  server: {
    handlers: {
      GET: ({ request }) => handleConnections(request, { provider: "github", action: "setup" }),
    },
  },
});
