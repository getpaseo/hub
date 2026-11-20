import { createFileRoute } from "@tanstack/react-router";

// Hub publishes no well-known resources. Clients probe them anyway (OAuth discovery under
// /.well-known/oauth-*, browser devtools), often with Accept: application/json, which the page
// router rejects with a 500. Answer every probe with a plain 404 instead.
export const Route = createFileRoute("/.well-known/$")({
  server: {
    handlers: {
      GET: wellKnownNotFound,
      HEAD: wellKnownNotFound,
      POST: wellKnownNotFound,
      OPTIONS: wellKnownNotFound,
    },
  },
});

function wellKnownNotFound(): Response {
  return Response.json(
    {
      error: "not_found",
      message: "Paseo Hub does not publish this well-known resource.",
    },
    { status: 404 },
  );
}
