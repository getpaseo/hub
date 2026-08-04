import { createFileRoute } from "@tanstack/react-router";
import { RegistrationApproval } from "../../daemons/account-daemons.js";
import { useActiveAccount } from "../../auth/active-account.js";

export const Route = createFileRoute("/_shell/activate")({ component: Activate });

function Activate() {
  const account = useActiveAccount();
  return (
    <RegistrationApproval accountId={account.account.id} organizationId={account.organization.id} />
  );
}
