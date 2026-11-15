import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import {
  GitHubAccountChooserPage,
  GitHubAccountChooserSkeleton,
  GitHubAccountChooserUnavailable,
} from "../connections/github-accounts/chooser.js";
import { githubAccountChoices } from "../connections/github-accounts/functions.js";

/**
 * GitHub's connection chooser. Its only input is the attempt's state; an attempt that is gone
 * sends the browser back to where the connection started, with the reason.
 *
 * A step of the round trip to GitHub, so it sits outside the dashboard shell: a connection
 * started from first-run app setup reaches it before the shell exists for that account.
 */
export const Route = createFileRoute("/integrations_/github")({
  validateSearch: z.object({ state: z.string().catch("") }),
  loaderDeps: ({ search }) => ({ state: search.state }),
  loader: async ({ deps }) => {
    const result = await githubAccountChoices({ data: { state: deps.state } });
    if (result.status === "ok" && "url" in result.data) {
      throw redirect({ href: result.data.url, reloadDocument: true });
    }
    return result;
  },
  pendingComponent: GitHubAccountChooserSkeleton,
  component: GitHubAccountChooserRoute,
});

function GitHubAccountChooserRoute() {
  const result = Route.useLoaderData();
  const { state } = Route.useSearch();
  if (result.status === "error" || "url" in result.data) {
    return <GitHubAccountChooserUnavailable error={result} />;
  }
  return <GitHubAccountChooserPage state={state} chooser={result.data} />;
}
