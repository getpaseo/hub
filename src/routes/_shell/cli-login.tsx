import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { useActiveAccount } from "../../auth/active-account.js";
import { CliLoginApproval, parseCliLoginSearch } from "../../cli-authorizations/approval.js";

export const Route = createFileRoute("/_shell/cli-login")({
  staticData: { breadcrumb: "CLI login" },
  validateSearch: parseCliLoginSearch,
  component: CliLogin,
});

function CliLogin() {
  const account = useActiveAccount();
  const { code } = Route.useSearch();
  const navigate = Route.useNavigate();
  const enterCode = useCallback(
    (entered: string) => {
      void navigate({ search: { code: entered }, replace: true });
    },
    [navigate],
  );
  return (
    <CliLoginApproval
      accountId={account.account.id}
      organizationId={account.organization.id}
      code={code}
      onCode={enterCode}
    />
  );
}
