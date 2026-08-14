import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useState, type FormEvent } from "react";
import { AuthCard, AuthLayout } from "../components/app/auth-layout.js";
import { Button } from "../components/ui/button.js";
import { Field, FieldSet } from "../components/ui/field.js";
import { formValue } from "./account-actions.js";
import { ErrorSummary } from "./account-states.js";
import { FormField } from "./form-field.js";
import { setUpInstance } from "./functions.js";
import type { Result } from "../contract/respond.js";

type SetupResult = Result<{ state: "claimed" | "unavailable" }>;

/**
 * What a signed-out visitor sees on a Hub nobody owns yet: an invitation to become its
 * operator instead of a sign-in wall with no account to sign in to. The claim can lose a race
 * with another browser or a configured bootstrap, so the closed answer is a first-class state
 * here rather than an error — the instance is fine, this visitor just isn't its operator.
 */
export function InstanceSetupEntry() {
  const queryClient = useQueryClient();
  const [operatorRequested, setOperatorRequested] = useState(false);
  const claim = useMutation({
    mutationFn: useServerFn(setUpInstance) as (
      input: Parameters<typeof setUpInstance>[0],
    ) => Promise<SetupResult>,
    onSuccess: async (result) => {
      if (result.status === "ok" && result.data.state === "claimed") {
        await queryClient.invalidateQueries({ queryKey: ["account"] });
      }
    },
  });
  const requestOperator = useCallback(() => setOperatorRequested(true), []);
  const returnToWelcome = useCallback(() => {
    claim.reset();
    setOperatorRequested(false);
  }, [claim]);
  const continueToSignIn = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["account"] });
  }, [queryClient]);
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      claim.mutate({
        data: {
          name: formValue(data, "name"),
          email: formValue(data, "email"),
          password: formValue(data, "password"),
          organizationName: formValue(data, "organizationName"),
        },
      });
    },
    [claim],
  );

  if (!operatorRequested) return <Welcome onBegin={requestOperator} />;
  const outcome = claim.data?.status === "ok" ? claim.data.data.state : undefined;
  if (outcome === "unavailable") return <SetupClosed onContinue={continueToSignIn} />;
  // Stay busy through the account refetch that follows a claim, so the form cannot be
  // resubmitted in the moment between the commit and the dashboard.
  const busy = claim.isPending || outcome === "claimed";
  let message: string | undefined;
  if (claim.data?.status === "error") message = claim.data.error.message;
  if (claim.isError) message = "We couldn't set up this Hub. Try again.";

  return (
    <AuthLayout>
      <AuthCard
        titleId="instance-setup-heading"
        title="Set up Paseo Hub"
        description="Sign in with these credentials from now on. Invite your team once you're in."
      >
        <ErrorSummary message={message} />
        <form method="post" onSubmit={submit} aria-label="Set up Paseo Hub" aria-busy={busy}>
          <FieldSet className="gap-4" disabled={busy}>
            <FormField label="Name" name="name" id="operator-name" autoComplete="name" />
            <FormField
              label="Email"
              name="email"
              id="operator-email"
              type="email"
              autoComplete="email"
            />
            <FormField
              label="Password"
              name="password"
              id="operator-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
            />
            <FormField
              label="Organization name"
              name="organizationName"
              id="operator-organization"
              autoComplete="organization"
            />
            <Field>
              <Button type="submit" disabled={busy}>
                Finish setup
              </Button>
            </Field>
          </FieldSet>
        </form>
        <Button type="button" variant="ghost" disabled={busy} onClick={returnToWelcome}>
          Back
        </Button>
      </AuthCard>
    </AuthLayout>
  );
}

function Welcome({ onBegin }: { onBegin: () => void }) {
  return (
    <AuthLayout>
      <AuthCard
        titleId="welcome-heading"
        title="Welcome to Paseo Hub"
        description="Nobody has set up this Hub yet."
      >
        <p role="status" className="sr-only">
          Setup required
        </p>
        <p className="text-sm text-muted-foreground">
          The first account becomes the instance operator, with your first organization and its
          default project.
        </p>
        <Button type="button" onClick={onBegin}>
          Set up Paseo Hub
        </Button>
      </AuthCard>
    </AuthLayout>
  );
}

function SetupClosed({ onContinue }: { onContinue: () => void }) {
  return (
    <AuthLayout>
      <AuthCard
        titleId="setup-closed-heading"
        title="This Hub is already set up"
        description="Someone claimed it while this page was open. Sign in with an account on this Hub."
      >
        <Button type="button" onClick={onContinue}>
          Continue to sign in
        </Button>
      </AuthCard>
    </AuthLayout>
  );
}
