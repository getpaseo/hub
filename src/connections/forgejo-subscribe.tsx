/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- one dialog's own form fields, not a list row rendered many times */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useState, type FormEvent } from "react";
import { Combobox, type ComboboxOption } from "../components/app/combobox.js";
import { CopyField } from "../components/app/copy-field.js";
import { Disclosure } from "../components/app/disclosure.js";
import { FailureAlert, NoticeAlert } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { HelpText } from "../components/app/help-text.js";
import { FormField } from "../components/app/form-field.js";
import { SegmentedControl } from "../components/app/segmented-control.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { FieldSet } from "../components/ui/field.js";
import {
  listForgejoOrgs,
  subscribeForgejoWebhook,
  type ForgejoSubscribed,
  type ForgejoSubscribeTarget,
} from "./functions.js";

export interface ForgejoSubscribeScope {
  organizationSlug: string;
  projectSlug?: string | undefined;
}

// shared by the post-connect step and the existing-connection dialog, hence a hook not a component
export function useForgejoSubscribe(
  connectionId: string,
  scope: ForgejoSubscribeScope,
  options: { enabled?: boolean } = {},
) {
  const loadOrgs = useServerFn(listForgejoOrgs);
  const orgsQuery = useQuery({
    queryKey: ["forgejo-orgs", connectionId],
    queryFn: () => loadOrgs({ data: { ...scope, connectionId } }),
    enabled: options.enabled ?? true,
    // avoid refetching on tab focus and pulling the combobox out from under the operator
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const subscribe = useMutation({ mutationFn: useServerFn(subscribeForgejoWebhook) });
  const [mode, setMode] = useState<"user" | "org">("user");
  const [org, setOrg] = useState("");
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>, onSubscribed: (subscribed: ForgejoSubscribed) => void) => {
      event.preventDefault();
      const target: ForgejoSubscribeTarget =
        mode === "user" ? { scope: "user" } : { scope: "org", org };
      subscribe.mutate(
        { data: { ...scope, connectionId, target } },
        {
          onSuccess: (response) => {
            if (response.status === "ok") onSubscribed(response.data);
          },
        },
      );
    },
    [connectionId, mode, org, scope, subscribe],
  );
  return { orgsQuery, subscribe, mode, setMode, org, setOrg, submit };
}

type SubscribeState = ReturnType<typeof useForgejoSubscribe>;

// undefined until the orgs query has landed
export function listedWebhookUrl(state: SubscribeState): string | undefined {
  const result = state.orgsQuery.data;
  return result?.status === "ok" ? result.data.webhookUrl : undefined;
}

export function listedWebhookSecret(state: SubscribeState): string | undefined {
  const result = state.orgsQuery.data;
  return result?.status === "ok" ? result.data.webhookSecret : undefined;
}

// the secret is stored plaintext so it can be read back here, not just shown once at connect time
export function ForgejoWebhookCopyFields({
  webhookUrl,
  webhookSecret,
}: {
  webhookUrl: string;
  webhookSecret: string;
}) {
  return (
    <>
      <CopyField label="Target URL" value={webhookUrl} />
      <CopyField label="Secret" value={webhookSecret} copyLabel="Copy webhook secret" />
    </>
  );
}

function orgHintFor(unavailable: boolean, noOrgs: boolean): string | undefined {
  if (unavailable) return "Hub couldn't list organizations with this token.";
  if (noOrgs) return "This token isn't a member of any organization.";
  return undefined;
}

export function forgejoSubscribeSuccessMessage(subscribed: ForgejoSubscribed): string {
  // owner is the account login for a "user" scope subscribe, an org name otherwise
  return `Subscribed to ${subscribed.owner}'s repositories.`;
}

function ForgejoSubscribeFields({
  state,
  accountLogin,
}: {
  state: SubscribeState;
  accountLogin: string;
}) {
  const { orgsQuery, subscribe, mode, setMode, org, setOrg } = state;
  const listed = orgsQuery.data?.status === "ok" ? orgsQuery.data.data : undefined;
  const orgOptions: ComboboxOption[] = (listed?.orgs ?? []).map((one) => ({
    value: one.username,
    label: one.username,
  }));
  const noOrgs = listed !== undefined && orgOptions.length === 0;
  const orgHint = orgHintFor(listed?.unavailable === true, noOrgs);
  const failed = subscribe.isError || subscribe.data?.status === "error";
  return (
    <>
      {failed ? (
        <FailureAlert
          title="Webhook wasn't created"
          error={subscribe.isError ? subscribe.error : subscribe.data}
          fallback="Hub couldn't set up the webhook on that instance."
        />
      ) : null}
      <SegmentedControl
        label="Subscribe"
        description="Which repositories should trigger workflows?"
        value={mode}
        onChange={(value) => setMode(value === "org" ? "org" : "user")}
        options={[
          { value: "user", label: `Repositories owned by ${accountLogin}` },
          {
            value: "org",
            label: "One organization",
            disabled: noOrgs,
            ...(orgHint === undefined ? {} : { hint: orgHint }),
          },
        ]}
      />
      {mode === "user" ? (
        <HelpText>
          {`Covers only repositories ${accountLogin} owns. A repository where this account is a collaborator instead needs an organization hook, or one added by hand on that repository.`}
        </HelpText>
      ) : null}
      {mode === "org" ? (
        <FormField id="forgejo-subscribe-org" label="Organization" required>
          {(control) => (
            <Combobox
              {...control}
              value={org}
              onChange={(option) => setOrg(option.value)}
              options={orgOptions}
              loading={orgsQuery.isPending}
              placeholder="Select an organization"
              empty="No organizations found."
            />
          )}
        </FormField>
      ) : null}
    </>
  );
}

function ForgejoSubscribeFormBody({
  state,
  accountLogin,
  onSubscribed,
}: {
  state: SubscribeState;
  accountLogin: string;
  onSubscribed: (subscribed: ForgejoSubscribed) => void;
}) {
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => state.submit(event, onSubscribed),
    [state, onSubscribed],
  );
  const busy = state.subscribe.isPending;
  // submitting org:"" throws in the validator, so require a pick before Subscribe is reachable
  const missingOrg = state.mode === "org" && state.org.trim().length === 0;
  return (
    <form aria-label="Subscribe to Forgejo events" aria-busy={busy} onSubmit={handleSubmit}>
      <FieldSet disabled={busy}>
        <ForgejoSubscribeFields state={state} accountLogin={accountLogin} />
        <FormActions>
          <Button type="submit" disabled={missingOrg}>
            Subscribe
          </Button>
        </FormActions>
      </FieldSet>
    </form>
  );
}

export function ForgejoSubscribeStep({
  connectionId,
  accountLogin,
  scope,
  subscribed,
  onSubscribed,
}: {
  connectionId: string;
  accountLogin: string;
  scope: ForgejoSubscribeScope;
  subscribed: ForgejoSubscribed | undefined;
  onSubscribed: (subscribed: ForgejoSubscribed) => void;
}) {
  const state = useForgejoSubscribe(connectionId, scope);
  if (subscribed !== undefined) {
    return <NoticeAlert tone="success">{forgejoSubscribeSuccessMessage(subscribed)}</NoticeAlert>;
  }
  return (
    <ForgejoSubscribeFormBody
      state={state}
      accountLogin={accountLogin}
      onSubscribed={onSubscribed}
    />
  );
}

// subscribe later, for a connection that already exists
export function ForgejoSubscribeDialog({
  connectionId,
  accountLogin,
  organizationSlug,
  open,
  onOpenChange,
}: {
  connectionId: string;
  accountLogin: string;
  organizationSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [subscribed, setSubscribed] = useState<ForgejoSubscribed | undefined>(undefined);
  const [manualOpen, setManualOpen] = useState(false);
  // mounted per row regardless of dialog open state (panels.tsx), so gate the org query
  const state = useForgejoSubscribe(connectionId, { organizationSlug }, { enabled: open });
  // the hook instance outlives the dialog, so reset it by hand on close or reopening
  // shows the previous attempt's failure and scope
  const close = useCallback(
    (next: boolean) => {
      onOpenChange(next);
      if (!next) {
        setSubscribed(undefined);
        state.subscribe.reset();
        state.setMode("user");
        state.setOrg("");
      }
    },
    [onOpenChange, state],
  );
  const webhookUrl = listedWebhookUrl(state);
  const webhookSecret = listedWebhookSecret(state);
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Subscribe to repositories</DialogTitle>
          <DialogDescription>
            Choose which of your Forgejo repositories should trigger workflows.
          </DialogDescription>
        </DialogHeader>
        {subscribed === undefined ? (
          <ForgejoSubscribeFormBody
            state={state}
            accountLogin={accountLogin}
            onSubscribed={setSubscribed}
          />
        ) : (
          <NoticeAlert tone="success">{forgejoSubscribeSuccessMessage(subscribed)}</NoticeAlert>
        )}
        {webhookUrl === undefined || webhookSecret === undefined ? null : (
          <Disclosure
            id="forgejo-manual-webhook"
            open={manualOpen}
            onOpenChange={setManualOpen}
            title="Add the webhook by hand"
            description="For another repository, or if it was removed from Forgejo."
          >
            <ForgejoWebhookCopyFields webhookUrl={webhookUrl} webhookSecret={webhookSecret} />
          </Disclosure>
        )}
        <FormActions>
          <Button type="button" variant="outline" onClick={() => close(false)}>
            Done
          </Button>
        </FormActions>
      </DialogContent>
    </Dialog>
  );
}
