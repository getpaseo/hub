import { createFileRoute } from "@tanstack/react-router";
import { handleProviderRequest } from "../../../../../server/runtime.js";

// one endpoint per connection, the id in the path picks the secret to check the
// signature against since a forgejo body names no hub tenant
export const Route = createFileRoute("/api/integrations/forgejo/events/$connectionId")({
  server: {
    handlers: { POST: ({ request }) => handleProviderRequest("forgejo.events", request) },
  },
});
