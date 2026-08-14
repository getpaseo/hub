import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AuthCard, AuthLayout } from "../components/app/auth-layout.js";
import { Button } from "../components/ui/button.js";
import { Field, FieldSet } from "../components/ui/field.js";
import { formValue } from "./account-actions.js";
import { ErrorSummary } from "./account-states.js";
import { FormField } from "./form-field.js";
import { setUpInstance } from "./functions.js";
import type { Result } from "../contract/respond.js";

type SetupResult = Result<{ state: "claimed" | "unavailable" }>;

const WELCOME_HEADING = "welcome-heading";
const SETUP_HEADING = "instance-setup-heading";
const SETUP_CLOSED_HEADING = "setup-closed-heading";

/**
 * Each screen here replaces the whole page, so the card that arrives takes focus. Without this a
 * keyboard or screen-reader user is dropped on `document.body` and has to tab from the top again.
 * Form-level errors are deliberately not focused: the alert announces itself and focus stays
 * where the user can correct and resubmit.
 */
function useHeadingFocus(headingId: string): void {
  useEffect(() => {
    document.getElementById(headingId)?.focus();
  }, [headingId]);
}

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
  let message: string | undefined;
  if (claim.data?.status === "error") message = claim.data.error.message;
  if (claim.isError) message = "We couldn't set up this Hub. Try again.";
  return (
    <OperatorForm
      // Stay busy through the account refetch that follows a claim, so the form cannot be
      // resubmitted in the moment between the commit and the dashboard.
      busy={claim.isPending || outcome === "claimed"}
      message={message}
      onSubmit={submit}
      onBack={returnToWelcome}
    />
  );
}

function Welcome({ onBegin }: { onBegin: () => void }) {
  useHeadingFocus(WELCOME_HEADING);
  return (
    <AuthLayout>
      <AuthCard
        titleId={WELCOME_HEADING}
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

function OperatorForm({
  busy,
  message,
  onSubmit,
  onBack,
}: {
  busy: boolean;
  message: string | undefined;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
}) {
  useHeadingFocus(SETUP_HEADING);
  return (
    <AuthLayout>
      <AuthCard
        titleId={SETUP_HEADING}
        title="Set up Paseo Hub"
        description="Sign in with these credentials from now on. Invite your team once you're in."
      >
        <ErrorSummary message={message} />
        <form method="post" onSubmit={onSubmit} aria-label="Set up Paseo Hub" aria-busy={busy}>
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
        <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
          Back
        </Button>
      </AuthCard>
    </AuthLayout>
  );
}

function SetupClosed({ onContinue }: { onContinue: () => void }) {
  useHeadingFocus(SETUP_CLOSED_HEADING);
  return (
    <AuthLayout>
      <AuthCard
        titleId={SETUP_CLOSED_HEADING}
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
