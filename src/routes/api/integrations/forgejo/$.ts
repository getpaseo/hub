import { createFileRoute } from "@tanstack/react-router";
import { handleProviderRequest } from "../../../../server/runtime.js";

export const Route = createFileRoute("/api/integrations/forgejo/$")({
  server: {
    handlers: {
      GET: handleForgejoIntegrationRequest,
      POST: handleForgejoIntegrationRequest,
    },
  },
});

function handleForgejoIntegrationRequest({ request }: { request: Request }): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.includes("/instances")) {
    return handleProviderRequest("forgejo.instances", request);
  }
  if (path.includes("/connections")) {
    return handleProviderRequest("forgejo.connections", request);
  }
  return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
}
