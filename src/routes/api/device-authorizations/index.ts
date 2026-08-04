import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/api/device-authorizations/")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await getApplication()).operations.handleDeviceAuthorizationStart(request),
    },
  },
});
