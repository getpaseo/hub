import { createFileRoute } from "@tanstack/react-router";
import { handleProviderRequest } from "../../../../server/runtime.js";

export const Route = createFileRoute("/api/integrations/google-chat/events")({
  server: {
    handlers: { POST: ({ request }) => handleProviderRequest("google-chat.events", request) },
  },
});
