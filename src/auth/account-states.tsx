import { useEffect, useRef } from "react";
import {
  AuthCard,
  AuthCardSkeleton,
  AuthLayout,
  ProductMark,
} from "../components/app/auth-layout.js";
import { AuthActions } from "../components/app/auth-form.js";
import { Alert } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";

/**
 * What went wrong with the last account action, above the form or the panel it happened in.
 *
 * It carries no margin: both the places it appears already space their children — the auth card
 * gaps its stack, and so does the dashboard's page column — and a margin on top of that gap put
 * two rhythms between one error and one form.
 */
export function ErrorSummary({ message }: { message: string | undefined }) {
  const alert = useRef<HTMLDivElement>(null);
  // Submitting disables the form, which blurs the button that was focused, so on failure focus
  // would land on the document body. Take it to the message instead: the user hears what went
  // wrong and tabs straight back into the fields they need to fix.
  useEffect(() => {
    if (message !== undefined) alert.current?.focus();
  }, [message]);
  return message === undefined ? null : (
    <Alert ref={alert} tabIndex={-1} variant="destructive">
      {message}
    </Alert>
  );
}

/**
 * Rendered while the account is still unknown — including every server render, which
 * has not yet resolved the session. It must not resolve the question it is waiting on:
 * showing a sign-in card here tells a signed-in user they are signed out.
 */
export function LoadingEntry() {
  return (
    <main
      aria-label="Loading Paseo Hub"
      aria-busy="true"
      className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6"
    >
      <ProductMark />
      {/* The card whichever screen wins will be, held open at its own size so the mark
          does not jump up the page when the account resolves. */}
      <div className="w-full max-w-sm">
        <AuthCardSkeleton />
      </div>
    </main>
  );
}

export function FailedEntry({ message }: { message: string }) {
  return (
    <AuthLayout>
      <AuthCard titleId="account-failed-heading" title="Sign in to Paseo Hub">
        <Alert variant="destructive">{message}</Alert>
      </AuthCard>
    </AuthLayout>
  );
}

export function UnavailableInvitation({ message }: { message: string | undefined }) {
  return (
    <AuthLayout>
      <AuthCard
        titleId="invitation-unavailable-heading"
        title="Invitation unavailable"
        description="This link is invalid, expired, already used, or belongs to another account."
      >
        {message === undefined ? null : <Alert variant="destructive">{message}</Alert>}
        <AuthActions>
          <Button asChild size="lg">
            <a href="/">Continue to Paseo Hub</a>
          </Button>
        </AuthActions>
      </AuthCard>
    </AuthLayout>
  );
}
