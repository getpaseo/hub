/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the generated route type cannot express a server-resolved organization slug */
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useActiveAccount } from "../../auth/active-account.js";
import { connectionReturnSearchSchema } from "../../connections/result-contract.js";

/**
 * The integrations landing. A provider callback that could not be tied to the attempt that
 * started it does not know which organization to return to, so it returns here; the active
 * organization's integrations page is the only place that reads what it carries.
 */
export const Route = createFileRoute("/_shell/integrations")({
  validateSearch: connectionReturnSearchSchema,
  component: IntegrationsLanding,
});

function IntegrationsLanding() {
  const account = useActiveAccount();
  const search = Route.useSearch();
  return (
    <Navigate
      to={`/o/${account.organization.slug}/integrations` as never}
      search={search as never}
      replace
    />
  );
}
