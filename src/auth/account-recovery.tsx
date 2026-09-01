import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useState, type FormEvent } from "react";
import { AuthCard, AuthLayout } from "../components/app/auth-layout.js";
import { Button } from "../components/ui/button.js";
import { Field, FieldSet } from "../components/ui/field.js";
import { ErrorSummary } from "./account-states.js";
import { formValue } from "./account-actions.js";
import { FormField } from "./form-field.js";
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
  let message: string | undefined;
  if (request.data?.status === "error") message = request.data.error.message;
  if (request.isError) {
    message = "Hub did not receive the reset request. Check your connection and try again.";
  }
  return (
    <AuthLayout>
      <AuthCard
        titleId="forgot-password-heading"
        title="Reset your password"
        description="Enter your account email and we'll send a reset link if the account exists."
      >
        <ErrorSummary message={message} />
        {sent ? (
          <div className="grid gap-4">
            <p role="status" className="text-sm text-muted-foreground">
              If an account exists for that email, a password reset link is on its way.
            </p>
            <Button type="button" onClick={onBack}>
              Back to sign in
            </Button>
          </div>
        ) : (
          <form method="post" onSubmit={submit} aria-label="Reset password">
            <FieldSet className="gap-4" disabled={request.isPending}>
              <FormField
                label="Email"
                name="email"
                id="forgot-password-email"
                type="email"
                autoComplete="email"
              />
              <Field>
                <Button type="submit" disabled={request.isPending}>
                  Send reset link
                </Button>
              </Field>
              <Button type="button" variant="ghost" disabled={request.isPending} onClick={onBack}>
                Back to sign in
              </Button>
            </FieldSet>
          </form>
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
  let message: string | undefined;
  if (resend.data?.status === "error") message = resend.data.error.message;
  if (resend.isError) {
    message = "Hub did not receive the resend result. Check your connection and try again.";
  }
  return (
    <AuthLayout>
      <AuthCard
        titleId="verification-pending-heading"
        title="Check your email"
        description={`We sent a verification link to ${email}. Open it to finish signing in.`}
      >
        <ErrorSummary message={message} />
        {resend.data?.status === "ok" && (
          <p role="status" className="text-sm text-muted-foreground">
            If this address still needs verification, a new link is on its way.
          </p>
        )}
        <div className="grid gap-2">
          <Button type="button" disabled={resend.isPending} onClick={resendEmail}>
            Resend verification email
          </Button>
          <Button type="button" variant="ghost" disabled={resend.isPending} onClick={onBack}>
            Back to sign in
          </Button>
        </div>
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
        <Button type="button" className="w-full" onClick={leaveAuthCallback}>
          {failed ? "Back to sign in" : "Continue"}
        </Button>
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
          <Button type="button" className="w-full" onClick={leaveAuthCallback}>
            Back to sign in
          </Button>
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
          <Button type="button" className="w-full" onClick={leaveAuthCallback}>
            Back to sign in
          </Button>
        </AuthCard>
      </AuthLayout>
    );
  }
  let message: string | undefined;
  if (reset.data?.status === "error") message = reset.data.error.message;
  if (reset.isError) {
    message = "Hub did not receive the password reset result. Check your connection and try again.";
  }
  return (
    <AuthLayout>
      <AuthCard
        titleId="password-reset-heading"
        title="Choose a new password"
        description="Use at least 12 characters."
      >
        <ErrorSummary message={message} />
        <form method="post" onSubmit={submit} aria-label="Choose a new password">
          <FieldSet className="gap-4" disabled={reset.isPending}>
            <FormField
              label="New password"
              name="newPassword"
              id="reset-password-new"
              type="password"
              autoComplete="new-password"
              minLength={12}
            />
            <FormField
              label="Confirm new password"
              name="confirmPassword"
              id="reset-password-confirm"
              type="password"
              autoComplete="new-password"
              minLength={12}
            />
            <Field>
              <Button type="submit" disabled={reset.isPending}>
                Save new password
              </Button>
            </Field>
          </FieldSet>
        </form>
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
