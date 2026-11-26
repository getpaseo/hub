import { createFileRoute } from "@tanstack/react-router";
import { INTEGRATION_ID_PATTERN } from "../../../../integrations/browser-registry.js";
import { handleConnectionAction, handleProviderRequest } from "../../../../server/runtime.js";

const ACTION_PATTERN = /^[a-z][a-z0-9_-]*$/u;

function parseRouteSegments(request: Request): { provider: string; action: string } | undefined {
  const segments = new URL(request.url).pathname.split("/");
  const provider = segments[3] ?? "";
  const action = segments[4] ?? "";
  if (!INTEGRATION_ID_PATTERN.test(provider) || !ACTION_PATTERN.test(action)) {
    return undefined;
  }
  return { provider, action };
}

export const Route = createFileRoute("/api/integrations/$provider/$action")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const parsed = parseRouteSegments(request);
        if (parsed === undefined || parsed.action !== "callback") {
          return new Response("Not Found", { status: 404 });
        }
        return handleConnectionAction(request, parsed.provider, "callback");
      },
      POST: ({ request }) => {
        const parsed = parseRouteSegments(request);
        if (parsed === undefined) {
          return new Response("Not Found", { status: 404 });
        }
        return handleProviderRequest(`${parsed.provider}.${parsed.action}`, request);
      },
    },
  },
});
