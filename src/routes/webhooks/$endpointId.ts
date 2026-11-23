import { createFileRoute } from "@tanstack/react-router";
import { methodNotAllowed } from "../../http/method-not-allowed.js";
import { getApplication } from "../../server/runtime.js";

export const Route = createFileRoute("/webhooks/$endpointId")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const endpointId = new URL(request.url).pathname.split("/")[2] ?? "";
        return (await getApplication()).operations.handleWebhookDelivery(request, endpointId);
      },
    },
  },
});
