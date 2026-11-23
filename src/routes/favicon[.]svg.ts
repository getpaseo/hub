import { createFileRoute } from "@tanstack/react-router";
import { FAVICON_SVG } from "../brand/favicon.js";

export const Route = createFileRoute("/favicon.svg")({
  server: {
    handlers: {
      GET: () =>
        new Response(FAVICON_SVG, {
          headers: {
            "cache-control": "public, max-age=86400",
            "content-type": "image/svg+xml; charset=utf-8",
          },
        }),
    },
  },
});
