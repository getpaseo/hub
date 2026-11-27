import { createFileRoute } from "@tanstack/react-router";
import { isApplicationDraining } from "../server/runtime.js";

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: () =>
        isApplicationDraining()
          ? Response.json({ ok: false, status: "draining" }, { status: 503 })
          : Response.json({ ok: true }),
    },
  },
});
