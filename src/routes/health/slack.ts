import { createFileRoute } from "@tanstack/react-router";
import { handleSlackHealth } from "../../server/runtime.js";

export const Route = createFileRoute("/health/slack")({
  server: { handlers: { GET: () => handleSlackHealth() } },
});
