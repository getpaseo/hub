import { ChevronRight, Plus } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AuthCard, AuthLayout } from "../components/app/auth-layout.js";
import { AuthForm } from "../components/app/auth-form.js";
import { failureMessage } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { formValue } from "./account-actions.js";
import { ErrorSummary } from "./account-states.js";
import { FormField } from "../components/app/form-field.js";
import {
  acceptInvitation,
  createOrganization,
  selectOrganization,
  signIn,
  signOut,
  signUp,
} from "./functions.js";
import { LoginForm } from "./login-form.js";
import type { AccountState } from "./organization-contract.js";
import type { Result } from "../contract/respond.js";
import { ACCOUNT_MUTATION_KEY, useAccountMutationError } from "./account-mutation.js";
import { ForgotPasswordEntry, VerificationPendingEntry } from "./account-recovery.js";

type EmptyResult = Result<Record<string, never>>;
type AuthenticationResult = Result<{ state: "complete" | "verificationRequired" }>;
type AccountCommandResult = Result<{
  state: "sessionExpired" | "organizationRequired" | "complete";
}>;

type OrganizationAccount = Extract<AccountState, { status: "organizationRequired" | "active" }>;

/**
 * Sign in and sign up are the same decision seen from two sides, so only one is on
 * screen at a time. Stacking both forms made the card taller than the viewport.
 */
export function AccountEntry({ account }: { account: AccountState & { status: "signedOut" } }) {
  const invitationContext = account.invitation !== undefined;
  const invitationId = account.invitation?.id;
  const invitationSignInRequested = readInvitationSignInRequest();
  const [mode, setMode] = useState<"signIn" | "signUp">(invitationContext ? "signUp" : "signIn");
  const [forgotPassword, setForgotPassword] = useState(false);
  const [verificationEmail, setVerificationEmail] = useState<string>();
  useEffect(() => {
    if (invitationContext && invitationId !== undefined) {
      setMode(invitationSignInRequested ? "signIn" : "signUp");
    }
  }, [invitationContext, invitationId, invitationSignInRequested]);
  const invitationSignup = invitationContext && mode === "signUp";
  const queryClient = useQueryClient();
  const signInMutation = useMutation({
    mutationFn: useServerFn(signIn) as (
      input: Parameters<typeof signIn>[0],
    ) => Promise<AuthenticationResult>,
    onSuccess: async (result, input) => {
      if (result.status !== "ok") return;
      if (result.data.state === "verificationRequired") {
        setVerificationEmail(input.data.email);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const signUpMutation = useMutation({
    mutationFn: useServerFn(signUp) as (
      input: Parameters<typeof signUp>[0],
    ) => Promise<AuthenticationResult>,
    onSuccess: async (result, input) => {
      if (result.status !== "ok") return;
      if (result.data.state === "verificationRequired") {
        setVerificationEmail(input.data.email);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const busy = signInMutation.isPending || signUpMutation.isPending;
  const toggle = useCallback(() => {
    setMode((current) => (current === "signIn" ? "signUp" : "signIn"));
  }, []);
  const showForgotPassword = useCallback(() => setForgotPassword(true), []);
  const showSignIn = useCallback(() => {
    setForgotPassword(false);
    setVerificationEmail(undefined);
    setMode("signIn");
  }, []);
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const email = formValue(data, "email");
      const password = formValue(data, "password");
      if (mode === "signIn") {
        signInMutation.mutate({ data: { email, password } });
      } else {
        signUpMutation.mutate({
          data: {
            name: formValue(data, "name"),
            email,
            password,
            ...(account.invitation === undefined ? {} : { invitation: account.invitation.id }),
          },
        });
      }
    },
    [account.invitation, mode, signInMutation, signUpMutation],
  );
  const mutation = mode === "signIn" ? signInMutation : signUpMutation;
  const message =
    mutation.isError || mutation.data?.status === "error"
      ? failureMessage(
          mutation.data,
          mode === "signIn"
            ? "Hub did not receive the sign-in result. Check your connection and submit again."
            : "Hub did not receive the account-creation result. Check your connection and invitation before submitting again.",
        )
      : undefined;
  const { title, description } = accountEntryPresentation(account, mode, invitationSignup);

  if (forgotPassword) return <ForgotPasswordEntry onBack={showSignIn} />;
  if (verificationEmail !== undefined) {
    return (
      <VerificationPendingEntry
        email={verificationEmail}
        {...(account.invitation?.id === undefined ? {} : { invitation: account.invitation.id })}
        onBack={showSignIn}
      />
    );
  }

  return (
    <AuthLayout>
      <AuthCard titleId="account-entry-heading" title={title} description={description}>
        <p role="status" className="sr-only">
          Signed out
        </p>
        <ErrorSummary message={message} />
        <LoginForm
          key={mode}
          mode={mode}
          busy={busy}
          onSubmit={submit}
          {...(account.invitation?.email === undefined
            ? {}
            : { emailValue: account.invitation.email })}
          {...(invitationContext ? { emailReadOnly: true } : {})}
        />
        <SignedOutFooter
          registration={account.registration}
          invitationContext={invitationContext}
          mode={mode}
          busy={busy}
          onToggle={toggle}
          onForgotPassword={showForgotPassword}
        />
      </AuthCard>
    </AuthLayout>
  );
}

function accountEntryPresentation(
  account: AccountState & { status: "signedOut" },
  mode: "signIn" | "signUp",
  invitationSignup: boolean,
): { title: string; description: string } {
  if (invitationSignup) {
    return {
      title: `Join ${account.invitation?.organization.name}`,
      description: `${account.invitation?.inviterName} invited you as ${account.invitation?.role}.`,
    };
  }
  if (mode === "signIn") {
    return { title: "Sign in to Paseo Hub", description: "Your agent operations, in one place." };
  }
  return { title: "Create an account", description: "Get your agent operations in one place." };
}

function readInvitationSignInRequest(): boolean {
  if (typeof window === "undefined") return false;
  const historyState: unknown = window.history.state;
  return (
    historyState !== null &&
    typeof historyState === "object" &&
    Reflect.get(historyState, "paseoInvitationMode") === "sign-in"
  );
}

function SignedOutFooter({
  registration,
  invitationContext,
  mode,
  busy,
  onToggle,
  onForgotPassword,
}: {
  registration: Extract<AccountState, { status: "signedOut" }>["registration"];
  invitationContext: boolean;
  mode: "signIn" | "signUp";
  busy: boolean;
  onToggle: () => void;
  onForgotPassword: () => void;
}) {
  if (invitationContext) {
    return (
      <div className="grid gap-2 text-center text-sm text-muted-foreground">
        <p>
          This invitation is bound to the invited email address.{" "}
          {mode === "signIn" ? "Need an account?" : "Already have an account?"}{" "}
          <Button type="button" variant="link" disabled={busy} onClick={onToggle}>
            {mode === "signIn" ? "Create an account" : "Sign in"}
          </Button>
        </p>
        {mode === "signIn" && (
          <Button type="button" variant="link" disabled={busy} onClick={onForgotPassword}>
            Forgot password?
          </Button>
        )}
      </div>
    );
  }
  if (registration === "open") {
    return (
      <div className="grid gap-2 text-center text-sm text-muted-foreground">
        <p>
          {mode === "signIn" ? "No account yet?" : "Already have an account?"}{" "}
          <Button type="button" variant="link" disabled={busy} onClick={onToggle}>
            {mode === "signIn" ? "Create an account" : "Sign in"}
          </Button>
        </p>
        {mode === "signIn" && (
          <Button type="button" variant="link" disabled={busy} onClick={onForgotPassword}>
            Forgot password?
          </Button>
        )}
      </div>
    );
  }
  const message =
    registration === "invite_only"
      ? "Accounts are created by invitation. Ask an organization owner to invite you."
      : "Paseo Hub isn't accepting new accounts.";
  return (
    <div className="grid gap-2 text-center text-sm text-muted-foreground">
      <p>{message}</p>
      {mode === "signIn" && (
        <Button type="button" variant="link" disabled={busy} onClick={onForgotPassword}>
          Forgot password?
        </Button>
      )}
    </div>
  );
}

export function InvitationEntry({
  account: _account,
  invitation,
}: {
  account: OrganizationAccount;
  invitation: NonNullable<OrganizationAccount["invitation"]>;
}) {
  const queryClient = useQueryClient();
  const handleResult = useAccountCommandResult(queryClient, { clearInvitation: true });
  const accept = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: useServerFn(acceptInvitation) as (
      input: Parameters<typeof acceptInvitation>[0],
    ) => Promise<AccountCommandResult>,
    onSuccess: handleResult,
  });
  const leave = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: useServerFn(signOut) as (
      input: Parameters<typeof signOut>[0],
    ) => Promise<EmptyResult>,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const busy = accept.isPending || leave.isPending;
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      accept.mutate({
        data: { invitationId: formValue(new FormData(event.currentTarget), "invitationId") },
      });
    },
    [accept],
  );
  const message = useAccountMutationError();
  const signOutAccount = useCallback(() => leave.mutate({}), [leave]);
  return (
    <AuthLayout>
      <AuthCard
        titleId="invitation-heading"
        title={`Join ${invitation.organization.name}`}
        description={`${invitation.inviterName} invited you as ${invitation.role}.`}
      >
        <ErrorSummary message={message} />
        <AuthForm
          label="Accept invitation"
          busy={busy}
          submitLabel="Accept invitation"
          onSubmit={submit}
          secondaryLabel="Sign out"
          onSecondary={signOutAccount}
        >
          <Input type="hidden" name="invitationId" value={invitation.id} />
        </AuthForm>
      </AuthCard>
    </AuthLayout>
  );
}

export function OrganizationGate({
  account,
}: {
  account: AccountState & { status: "organizationRequired" };
}) {
  const [creating, setCreating] = useState(false);
  const create = useCallback(() => setCreating(true), []);
  const queryClient = useQueryClient();
  const handleResult = useAccountCommandResult(queryClient);
  const handleCompletion = useAccountCommandResult(queryClient, { clearInvitation: true });
  const select = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: useServerFn(selectOrganization) as (
      input: Parameters<typeof selectOrganization>[0],
    ) => Promise<AccountCommandResult>,
    onSuccess: handleResult,
  });
  const createOrganizationMutation = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: useServerFn(createOrganization) as (
      input: Parameters<typeof createOrganization>[0],
    ) => Promise<AccountCommandResult>,
    onSuccess: handleCompletion,
  });
  const leave = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: useServerFn(signOut) as (
      input: Parameters<typeof signOut>[0],
    ) => Promise<EmptyResult>,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const busy = select.isPending || createOrganizationMutation.isPending || leave.isPending;
  const message = useAccountMutationError();
  const selectSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      select.mutate({
        data: { organizationId: formValue(new FormData(event.currentTarget), "organizationId") },
      });
    },
    [select],
  );
  const createSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      createOrganizationMutation.mutate({
        data: { name: formValue(new FormData(event.currentTarget), "name") },
      });
      setCreating(false);
    },
    [createOrganizationMutation],
  );
  const signOutAccount = useCallback(() => leave.mutate({}), [leave]);

  return (
    <AuthLayout width="md">
      <AuthCard
        titleId="organization-heading"
        title="Choose an organization"
        descriptionRole="status"
        description={`Signed in as ${account.account.email}`}
      >
        <ErrorSummary message={message} />
        {account.memberships.length > 0 && (
          <ul aria-label="Organizations" className="grid gap-2">
            {account.memberships.map((membership) => (
              <li key={membership.id}>
                <form method="post" onSubmit={selectSubmit}>
                  <Input type="hidden" name="organizationId" value={membership.id} />
                  <button
                    type="submit"
                    disabled={busy}
                    className="flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors duration-150 hover:bg-accent disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1">
                      <TwoLine primary={membership.name} secondary={membership.role} />
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="sr-only">Choose</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {account.canCreateOrganization ? null : (
          <p className="text-sm text-muted-foreground">Ask an organization owner to invite you.</p>
        )}
        <FormActions>
          <Button type="button" variant="ghost" disabled={busy} onClick={signOutAccount}>
            Sign out
          </Button>
          {account.canCreateOrganization ? (
            <Button type="button" variant="outline" onClick={create} disabled={busy}>
              <Plus aria-hidden="true" />
              Create an organization
            </Button>
          ) : null}
        </FormActions>
      </AuthCard>
      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        busy={busy}
        title="Create an organization"
        label="Create organization"
        submitLabel="Create organization"
        onSubmit={createSubmit}
      >
        <FormField
          kind="text"
          label="Organization name"
          name="name"
          id="organization-name"
          required
        />
      </FormDialog>
    </AuthLayout>
  );
}

function useAccountCommandResult(
  queryClient: ReturnType<typeof useQueryClient>,
  options: { clearInvitation?: boolean } = {},
) {
  const { clearInvitation = false } = options;
  return useCallback(
    async (result: AccountCommandResult) => {
      if (result.status !== "ok") return;
      if (result.data.state === "sessionExpired") {
        const url = new URL(window.location.href);
        if (url.searchParams.has("invitation")) {
          window.history.replaceState(
            Object.assign({}, window.history.state, { paseoInvitationMode: "sign-in" }),
            "",
            url,
          );
        }
      }
      if (clearInvitation && result.data.state === "complete") {
        window.history.replaceState({}, "", "/");
      }
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
    [clearInvitation, queryClient],
  );
}
