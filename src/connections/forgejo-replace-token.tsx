/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- one dialog's own controls, not a list row rendered many times */
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useCallback } from "react";
import { FailureAlert } from "../components/app/failure-alert.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { FormField } from "../components/app/form-field.js";
import { replaceForgejoConnectionToken } from "./functions.js";

interface Scope {
  organizationSlug: string;
  projectSlug?: string | undefined;
}

// keeps the connection's id, webhook address and secret, just swaps the token
export function ForgejoReplaceTokenDialog({
  connectionId,
  scope,
  open,
  onOpenChange,
}: {
  connectionId: string;
  scope: Scope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const replace = useMutation({ mutationFn: useServerFn(replaceForgejoConnectionToken) });

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const accessToken = readField(form, "accessToken");
      replace.mutate(
        { data: { ...scope, connectionId, accessToken } },
        {
          onSuccess: (response) => {
            if (response.status === "ok") onOpenChange(false);
          },
        },
      );
    },
    [connectionId, onOpenChange, replace, scope],
  );

  const close = useCallback(
    (next: boolean) => {
      onOpenChange(next);
      if (!next) replace.reset();
    },
    [onOpenChange, replace],
  );

  const failed = replace.isError || replace.data?.status === "error";
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title="Replace token"
      description="Paste a new access token for the same account. The connection keeps its id, webhook address and secret."
      label="Replace Forgejo token"
      submitLabel="Replace"
      busy={replace.isPending}
      onSubmit={submit}
    >
      {failed ? (
        <FailureAlert
          title="Token wasn't replaced"
          error={replace.isError ? replace.error : replace.data}
          fallback="Hub couldn't replace that connection's token. Check it and try again."
        />
      ) : null}
      <FormField
        id="forgejo-replace-token"
        label="Access token"
        kind="secret"
        name="accessToken"
        required
        description="Settings, Applications, Generate New Token, on the same account this connection was made with."
      />
    </FormDialog>
  );
}

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}
