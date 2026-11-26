import { createFileRoute } from "@tanstack/react-router";
import { readHealth } from "../server/runtime.js";

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: async () => Response.json(await readHealth()),
    },
  },
});
