import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { accountState } from "./functions.js";
import { AccountEntry, InvitationEntry, OrganizationGate } from "./account-entry.js";
import { FailedEntry, LoadingEntry, UnavailableInvitation } from "./account-states.js";
import { DashboardShell } from "./dashboard-shell.js";
import { InstanceSetupEntry } from "./instance-setup-entry.js";
import { PasswordChangeEntry } from "./password-change.js";

export function AccountApp() {
  const loadAccount = useServerFn(accountState);
  const invitation =
    typeof window === "undefined"
      ? undefined
      : (new URLSearchParams(window.location.search).get("invitation") ?? undefined);
  const account = useQuery({
    queryKey: ["account", invitation],
    queryFn: () => loadAccount({ data: { invitation } }),
  });
  if (account.isPending) return <LoadingEntry />;
  if (account.isError || account.data.status === "error") {
    return (
      <FailedEntry
        message={
          account.data?.status === "error"
            ? account.data.error.message
            : "We couldn't load your Paseo Hub account."
        }
      />
    );
  }
  const state = account.data.data;
  if (state.status === "instanceSetupRequired") return <InstanceSetupEntry />;
  if (state.status === "passwordChangeRequired")
    return <PasswordChangeEntry account={state.account} />;
  if (state.invitationUnavailable === true) {
    return <UnavailableInvitation message="This invitation is unavailable." />;
  }
  if (state.status === "signedOut") return <AccountEntry account={state} />;
  if (state.invitation !== undefined) {
    return <InvitationEntry account={state} invitation={state.invitation} />;
  }
  if (state.status === "organizationRequired") return <OrganizationGate account={state} />;
  return <DashboardShell account={state} />;
}
