import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../../../server/runtime.js";

export const Route = createFileRoute("/api/integrations/github/manifest/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const applications = (await getApplication()).providerApplications;
        if (applications === null) return new Response("Not Found", { status: 404 });
        return applications.completeGitHubManifestRegistration(request);
      },
    },
  },
});
