import assert from "node:assert/strict";
import { it } from "vitest";
import { Route } from "./routes/agent-executions/$executionId/mcp.js";

/**
 * TanStack's `Constrain<ObjectLiteral, Fn>` handlers type resolves member
 * access against the function-form branch of the union even though this
 * route declares the plain object-literal form, so the generated route
 * type cannot express calling an individual method handler directly.
 */
interface McpRouteMethodHandlers {
  GET(): Response | Promise<Response>;
  DELETE(): Response | Promise<Response>;
}

// The execution capability MCP server is stateless and POST-only. Before this
// guard, an unhandled GET (SSE stream open) or DELETE (session terminate)
// fell through to the SPA route render: 200 HTML for an unknown execution id,
// or a 500 for a real one once it hit `handleExecutionCapabilities`. A 500
// makes MCP Streamable HTTP clients treat the server as dead instead of
// retrying with the one method it actually supports.
it("rejects GET on the MCP route with 405 and an Allow: POST header", async () => {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the generated route type cannot express calling one handler directly
  const handlers = Route.options.server?.handlers as unknown as McpRouteMethodHandlers;
  const response = await handlers.GET();

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

it("rejects DELETE on the MCP route with 405 and an Allow: POST header", async () => {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the generated route type cannot express calling one handler directly
  const handlers = Route.options.server?.handlers as unknown as McpRouteMethodHandlers;
  const response = await handlers.DELETE();

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});
