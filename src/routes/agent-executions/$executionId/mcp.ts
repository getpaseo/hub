import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/agent-executions/$executionId/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await getApplication()).operations.handleExecutionCapabilities(
          request,
          new URL(request.url).pathname.split("/")[2] ?? "",
        ),
      // This MCP server is stateless and POST-only: every call opens a
      // fresh transport and closes it once the response finishes, so there
      // is no SSE stream to resume (GET) or session to terminate (DELETE).
      // Without an explicit handler these methods fell through to the SPA
      // route render, which returned a misleading 200 (unknown execution
      // id) or crashed to 500 (real execution id) instead of the 405 the
      // MCP Streamable HTTP spec requires for an unsupported method - and a
      // 500 makes MCP clients mark the server as dead instead of retrying.
      GET: methodNotAllowed,
      DELETE: methodNotAllowed,
    },
  },
});

function methodNotAllowed(): Response {
  return Response.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
