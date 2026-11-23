import { createFileRoute } from "@tanstack/react-router";
import { methodNotAllowed } from "../../../http/method-not-allowed.js";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/agent-sessions/$sessionId/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await getApplication()).operations.handleSessionCapabilities(
          request,
          new URL(request.url).pathname.split("/")[2] ?? "",
        ),
      // Stateless MCP: no SSE stream to resume (GET) or session to end
      // (DELETE). Unhandled, these fall through to the SPA render and answer
      // 200 or 500; MCP clients treat a 500 as a dead server.
      GET: () => methodNotAllowed("POST"),
      DELETE: () => methodNotAllowed("POST"),
    },
  },
});
