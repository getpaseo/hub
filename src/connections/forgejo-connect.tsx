/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- one connect dialog's own controls, not a list row rendered many times */
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useCallback, useState } from "react";
import { Disclosure } from "../components/app/disclosure.js";
import { FormActions } from "../components/app/form-actions.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { FormField, type FieldControl } from "../components/app/form-field.js";
import { FailureAlert, NoticeAlert } from "../components/app/failure-alert.js";
import { HelpText } from "../components/app/help-text.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import {
  createForgejoConnection,
  type ForgejoCreatedConnection,
  type ForgejoSubscribed,
} from "./functions.js";
import { ForgejoSubscribeStep, ForgejoWebhookCopyFields } from "./forgejo-subscribe.js";

interface Scope {
  organizationSlug: string;
  projectSlug?: string | undefined;
}

// no oauth redirect, forgejo has no application to install. paste address + token instead,
// then offer to subscribe a webhook and show the manual fields, so the dialog stays open
// after success instead of closing.
export function ForgejoConnectAction({
  scope,
  busy,
  onConnected,
}: {
  scope: Scope;
  busy: boolean;
  onConnected: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<ForgejoCreatedConnection | undefined>(undefined);
  const [subscribed, setSubscribed] = useState<ForgejoSubscribed | undefined>(undefined);
  const [manualOpen, setManualOpen] = useState(false);
  const create = useMutation({ mutationFn: useServerFn(createForgejoConnection) });

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      create.mutate(
        {
          data: {
            ...scope,
            instanceBaseUrl: readField(form, "instanceBaseUrl"),
            accessToken: readField(form, "accessToken"),
          },
        },
        {
          onSuccess: (response) => {
            if (response.status !== "ok") return;
            setCreated(response.data);
            void onConnected();
          },
        },
      );
    },
    [create, onConnected, scope],
  );

  const close = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) {
        setCreated(undefined);
        setSubscribed(undefined);
        setManualOpen(false);
        create.reset();
      }
    },
    [create],
  );

  const openDialog = useCallback(() => setOpen(true), []);

  return (
    <>
      <Button disabled={busy} variant="outline" size="sm" onClick={openDialog}>
        Connect Forgejo
      </Button>
      {created === undefined ? (
        <FormDialog
          open={open}
          onOpenChange={close}
          title="Connect Forgejo"
          description="Tested against Forgejo. Gitea uses the same API and should work too. Paste the instance address and an access token."
          label="Connect Forgejo"
          submitLabel="Connect"
          busy={create.isPending}
          onSubmit={submit}
        >
          <ConnectFields create={create} />
        </FormDialog>
      ) : (
        <Dialog open={open} onOpenChange={close}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Connect Forgejo</DialogTitle>
            </DialogHeader>
            <ConnectedStep
              connection={created}
              organizationSlug={scope.organizationSlug}
              subscribed={subscribed}
              onSubscribed={setSubscribed}
              manualOpen={manualOpen}
              onManualOpenChange={setManualOpen}
            />
            <FormActions>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                Done
              </Button>
            </FormActions>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function ConnectFields({
  create,
}: {
  create: {
    isError: boolean;
    error: Error | null;
    data: Awaited<ReturnType<typeof createForgejoConnection>> | undefined;
  };
}) {
  // a thrown mutation (network failure) leaves create.data undefined, isError covers that
  const failed = create.isError || create.data?.status === "error";
  return (
    <>
      {failed ? (
        <FailureAlert
          title="Forgejo wasn't connected"
          error={create.isError ? create.error : create.data}
          fallback="Hub couldn't reach that instance with that token. Check the address and the token, then try again."
        />
      ) : null}
      <FormField
        id="forgejo-instance"
        label="Instance address"
        required
        description="The address you open the instance at. A subpath is kept; http is fine. A private or internal address needs your Hub operator to allow it first."
      >
        {instanceInput}
      </FormField>
      <FormField
        id="forgejo-token"
        label="Access token"
        required
        description="Settings, Applications, Generate New Token. Needs read:user so Hub can verify it, repository and issue read/write, plus write:user to subscribe to all your repositories, or write:organization and ownership of the organization to subscribe to one org. Deliveries sent by this account never trigger a workflow, so use a separate bot account for the connection if you also act through it by hand."
      >
        {tokenInput}
      </FormField>
    </>
  );
}

function ConnectedStep({
  connection,
  organizationSlug,
  subscribed,
  onSubscribed,
  manualOpen,
  onManualOpenChange,
}: {
  connection: ForgejoCreatedConnection;
  organizationSlug: string;
  subscribed: ForgejoSubscribed | undefined;
  onSubscribed: (subscribed: ForgejoSubscribed) => void;
  manualOpen: boolean;
  onManualOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      <NoticeAlert tone="success" title={`Connected as ${connection.accountLogin}`}>
        {`Saved as ${connection.slug} in ${organizationSlug}.`}
      </NoticeAlert>
      <ForgejoSubscribeStep
        connectionId={connection.id}
        accountLogin={connection.accountLogin}
        scope={{ organizationSlug }}
        subscribed={subscribed}
        onSubscribed={onSubscribed}
      />
      <Disclosure
        id="forgejo-manual-webhook"
        open={manualOpen}
        onOpenChange={onManualOpenChange}
        title="Add the webhook by hand"
        description="Skip subscribing here and add it on one repository instead."
      >
        <ForgejoWebhookCopyFields
          webhookUrl={connection.webhookUrl}
          webhookSecret={connection.webhookSecret}
        />
        <HelpText>
          {`Set Method to POST and Content Type to application/json, then pick the issue, pull request and push events. Add this under a repository's Settings, Webhooks, on ${connection.instanceBaseUrl}.`}
        </HelpText>
      </Disclosure>
    </>
  );
}

function instanceInput(control: FieldControl) {
  return (
    <Input
      {...control}
      name="instanceBaseUrl"
      type="url"
      placeholder="https://git.example.com"
      autoComplete="off"
    />
  );
}

function tokenInput(control: FieldControl) {
  return <Input {...control} name="accessToken" type="password" autoComplete="off" />;
}

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}
