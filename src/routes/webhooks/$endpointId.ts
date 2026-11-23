import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../server/runtime.js";

export const Route = createFileRoute("/webhooks/$endpointId")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        if (request.method !== "POST") {
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "POST" } },
          );
        }
        const endpointId = new URL(request.url).pathname.split("/")[2] ?? "";
        return (await getApplication()).operations.handleWebhookDelivery(request, endpointId);
      },
    },
  },
});
