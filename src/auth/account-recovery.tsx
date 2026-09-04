import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useState, type FormEvent } from "react";
import { AuthCard, AuthLayout } from "../components/app/auth-layout.js";
import { AuthForm } from "../components/app/auth-form.js";
import { failureMessage } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { StatusLine } from "../components/app/status-line.js";
import { Button } from "../components/ui/button.js";
import { ErrorSummary } from "./account-states.js";
import { formValue } from "./account-actions.js";
import { FormField } from "../components/app/form-field.js";
import { requestPasswordReset, resetPassword, sendVerificationEmail } from "./functions.js";
import type { Result } from "../contract/respond.js";

type EmptyResult = Result<Record<string, never>>;

export function ForgotPasswordEntry({ onBack }: { onBack: () => void }) {
  const [sent, setSent] = useState(false);
  const request = useMutation({
    mutationFn: useServerFn(requestPasswordReset) as (
      input: Parameters<typeof requestPasswordReset>[0],
    ) => Promise<EmptyResult>,
    onSuccess: (result) => {
      if (result.status === "ok") setSent(true);
    },
  });
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      request.mutate({
        data: { email: formValue(new FormData(event.currentTarget), "email") },
      });
    },
    [request],
  );
  const message =
    request.isError || request.data?.status === "error"
      ? failureMessage(
          request.data,
          "Hub did not receive the reset request. Check your connection and try again.",
        )
      : undefined;
  return (
    <AuthLayout>
      <AuthCard
        titleId="forgot-password-heading"
        title="Reset your password"
        description="Enter your account email and we'll send a reset link if the account exists."
      >
        <ErrorSummary message={message} />
        {sent ? (
          <>
            <StatusLine>
              If an account exists for that email, a password reset link is on its way.
            </StatusLine>
            <FormActions>
              <Button type="button" onClick={onBack}>
                Back to sign in
              </Button>
            </FormActions>
          </>
        ) : (
          <AuthForm
            label="Reset password"
            busy={request.isPending}
            submitLabel="Send reset link"
            onSubmit={submit}
            secondaryLabel="Back to sign in"
            onSecondary={onBack}
          >
            <FormField
              label="Email"
              name="email"
              id="forgot-password-email"
              kind="email"
              autoComplete="email"
              required
            />
          </AuthForm>
        )}
      </AuthCard>
    </AuthLayout>
  );
}

export function VerificationPendingEntry({
  email,
  invitation,
  onBack,
}: {
  email: string;
  invitation?: string;
  onBack: () => void;
}) {
  const resend = useMutation({
    mutationFn: useServerFn(sendVerificationEmail) as (
      input: Parameters<typeof sendVerificationEmail>[0],
    ) => Promise<EmptyResult>,
  });
  const resendEmail = useCallback(
    () => resend.mutate({ data: { email, ...(invitation === undefined ? {} : { invitation }) } }),
    [email, invitation, resend],
  );
  const message =
    resend.isError || resend.data?.status === "error"
      ? failureMessage(
          resend.data,
          "Hub did not receive the resend result. Check your connection and try again.",
        )
      : undefined;
  return (
    <AuthLayout>
      <AuthCard
        titleId="verification-pending-heading"
        title="Check your email"
        description={`We sent a verification link to ${email}. Open it to finish signing in.`}
      >
        <ErrorSummary message={message} />
        <StatusLine>
          {resend.data?.status === "ok"
            ? "If this address still needs verification, a new link is on its way."
            : undefined}
        </StatusLine>
        <FormActions>
          <Button type="button" variant="ghost" disabled={resend.isPending} onClick={onBack}>
            Back to sign in
          </Button>
          <Button type="button" disabled={resend.isPending} onClick={resendEmail}>
            Resend verification email
          </Button>
        </FormActions>
      </AuthCard>
    </AuthLayout>
  );
}

export function EmailVerificationResult({ error }: { error?: string }) {
  const expired = error === "TOKEN_EXPIRED";
  const failed = error !== undefined;
  let title = "Email verified";
  let description = "Your email address is verified and your account is ready.";
  if (expired) {
    title = "Verification link expired";
    description = "Request a new verification email from the sign-in screen.";
  } else if (failed) {
    title = "Verification link invalid";
    description =
      "This verification link cannot be used. Request a new one from the sign-in screen.";
  }
  return (
    <AuthLayout>
      <AuthCard titleId="email-verification-heading" title={title} description={description}>
        <FormActions>
          <Button type="button" onClick={leaveAuthCallback}>
            {failed ? "Back to sign in" : "Continue"}
          </Button>
        </FormActions>
      </AuthCard>
    </AuthLayout>
  );
}

export function PasswordResetEntry({
  token,
  callbackError,
}: {
  token?: string;
  callbackError?: string;
}) {
  const [complete, setComplete] = useState(false);
  const reset = useMutation({
    mutationFn: useServerFn(resetPassword) as (
      input: Parameters<typeof resetPassword>[0],
    ) => Promise<EmptyResult>,
    onSuccess: (result) => {
      if (result.status === "ok") setComplete(true);
    },
  });
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (token === undefined) return;
      const data = new FormData(event.currentTarget);
      const newPassword = formValue(data, "newPassword");
      const confirmation = event.currentTarget.elements.namedItem("confirmPassword");
      if (!(confirmation instanceof HTMLInputElement)) return;
      const matches = newPassword === formValue(data, "confirmPassword");
      confirmation.setCustomValidity(matches ? "" : "Passwords do not match.");
      if (!matches) {
        confirmation.reportValidity();
        return;
      }
      reset.mutate({ data: { token, newPassword } });
    },
    [reset, token],
  );
  if (callbackError !== undefined || token === undefined) {
    return (
      <AuthLayout>
        <AuthCard
          titleId="password-reset-invalid-heading"
          title="Reset link invalid or expired"
          description="Request a new password reset link from the sign-in screen."
        >
          <FormActions>
            <Button type="button" onClick={leaveAuthCallback}>
              Back to sign in
            </Button>
          </FormActions>
        </AuthCard>
      </AuthLayout>
    );
  }
  if (complete) {
    return (
      <AuthLayout>
        <AuthCard
          titleId="password-reset-complete-heading"
          title="Password reset"
          description="Your new password is ready. You can use it to sign in."
        >
          <FormActions>
            <Button type="button" onClick={leaveAuthCallback}>
              Back to sign in
            </Button>
          </FormActions>
        </AuthCard>
      </AuthLayout>
    );
  }
  const message =
    reset.isError || reset.data?.status === "error"
      ? failureMessage(
          reset.data,
          "Hub did not receive the password reset result. Check your connection and try again.",
        )
      : undefined;
  return (
    <AuthLayout>
      <AuthCard
        titleId="password-reset-heading"
        title="Choose a new password"
        description="Use at least 12 characters."
      >
        <ErrorSummary message={message} />
        <AuthForm
          label="Choose a new password"
          busy={reset.isPending}
          submitLabel="Save new password"
          onSubmit={submit}
        >
          <FormField
            label="New password"
            name="newPassword"
            id="reset-password-new"
            kind="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <FormField
            label="Confirm new password"
            name="confirmPassword"
            id="reset-password-confirm"
            kind="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </AuthForm>
      </AuthCard>
    </AuthLayout>
  );
}

function leaveAuthCallback(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("auth");
  url.searchParams.delete("error");
  url.searchParams.delete("token");
  window.location.replace(url.toString());
}
