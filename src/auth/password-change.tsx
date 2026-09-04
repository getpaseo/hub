import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useState, type FormEvent } from "react";
import { AuthCard, AuthLayout } from "../components/app/auth-layout.js";
import { AuthForm } from "../components/app/auth-form.js";
import { failureMessage } from "../components/app/failure-alert.js";
import { ErrorSummary } from "./account-states.js";
import { formValue } from "./account-actions.js";
import { FormField } from "../components/app/form-field.js";
import { changePassword, signOut } from "./functions.js";
import type { Result } from "../contract/respond.js";
import type { AccountState } from "./organization-contract.js";

type EmptyResult = Result<Record<string, never>>;

export function PasswordChangeEntry({
  account,
}: {
  account: Extract<AccountState, { status: "passwordChangeRequired" }>["account"];
}) {
  const queryClient = useQueryClient();
  const [validationError, setValidationError] = useState<string>();
  const save = useMutation({
    mutationFn: useServerFn(changePassword) as (
      input: Parameters<typeof changePassword>[0],
    ) => Promise<EmptyResult>,
    onSuccess: async (result) => {
      if (result.status === "ok") await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const leave = useMutation({
    mutationFn: useServerFn(signOut) as (
      input: Parameters<typeof signOut>[0],
    ) => Promise<EmptyResult>,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["account"] }),
  });
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const currentPassword = formValue(data, "currentPassword");
      const newPassword = formValue(data, "newPassword");
      if (newPassword !== formValue(data, "confirmPassword")) {
        setValidationError("New passwords do not match.");
        save.reset();
        return;
      }
      setValidationError(undefined);
      save.mutate({ data: { currentPassword, newPassword } });
    },
    [save],
  );
  const message =
    save.isError || save.data?.status === "error"
      ? failureMessage(
          save.data,
          "Hub did not receive the password-change result. Your existing password remains active; check your connection before submitting again.",
        )
      : validationError;
  const busy = save.isPending || leave.isPending;
  const signOutAccount = useCallback(() => {
    leave.mutate({});
  }, [leave]);
  return (
    <AuthLayout>
      <AuthCard
        titleId="password-change-heading"
        title="Choose a new password"
        description="Your temporary password must be replaced before you can continue."
      >
        <p className="text-sm text-muted-foreground">Signed in as {account.email}</p>
        <ErrorSummary message={message} />
        <AuthForm
          label="Choose a new password"
          busy={busy}
          submitLabel="Save password"
          onSubmit={submit}
          secondaryLabel="Sign out"
          onSecondary={signOutAccount}
        >
          <FormField
            label="Current password"
            name="currentPassword"
            id="current-password"
            kind="password"
            autoComplete="current-password"
            required
          />
          <FormField
            label="New password"
            name="newPassword"
            id="new-password"
            kind="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <FormField
            label="Confirm new password"
            name="confirmPassword"
            id="confirm-password"
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
