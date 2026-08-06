import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { AuthCard } from "../components/app/auth-layout.js";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { DataCell, DataRow, DataTable, type DataColumn } from "../components/app/data-table.js";
import { PageHeader } from "../components/app/page.js";
import { RowActions } from "../components/app/row-actions.js";
import { StatusPill } from "../components/app/status-pill.js";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Skeleton } from "../components/ui/skeleton.js";
import {
  daemonList,
  decideRegistration,
  inspectRegistration,
  renameDaemon,
  revokeDaemon,
  type BrowserDaemon,
  type DaemonCommand,
} from "./functions.js";
import type { Result } from "../contract/respond.js";
import { DAEMON_MUTATION_KEY } from "../auth/tenant-mutation.js";
import { daemonsQueryKey, refreshDaemons } from "./status.js";

const DAEMON_COLUMNS: readonly DataColumn[] = [
  { header: "Slug" },
  { header: "ID" },
  { header: "Status" },
  { header: "Last seen" },
  { header: "Registered" },
  { header: "", align: "end" },
];
const DAEMONS_EMPTY = {
  title: "No daemons registered",
  description: "Run paseo hub connect with this Hub URL to register one.",
};

export function DaemonsPanel({
  accountId,
  organizationId,
  organizationSlug,
}: {
  accountId: string;
  organizationId: string;
  organizationSlug: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = daemonsQueryKey(accountId, organizationId);
  const loadDaemons = useServerFn(daemonList);
  const snapshot = useQuery({
    queryKey,
    queryFn: () => loadDaemons({ data: { organizationSlug } }),
  });
  const rename = useMutation({
    mutationKey: DAEMON_MUTATION_KEY,
    mutationFn: useServerFn(renameDaemon) as (
      input: Parameters<typeof renameDaemon>[0],
    ) => Promise<Result<DaemonCommand>>,
    onSuccess: async (result) => {
      if (result.status !== "ok") return;
      if (result.data.state === "complete") {
        await refreshDaemons(queryClient, accountId, organizationId);
        return;
      }
      queryClient.removeQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const revoke = useMutation({
    mutationKey: DAEMON_MUTATION_KEY,
    mutationFn: useServerFn(revokeDaemon) as (
      input: Parameters<typeof revokeDaemon>[0],
    ) => Promise<Result<DaemonCommand>>,
    onSuccess: async (result) => {
      if (result.status !== "ok") return;
      if (result.data.state === "complete") {
        await refreshDaemons(queryClient, accountId, organizationId);
        return;
      }
      queryClient.removeQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const renameSelected = useCallback(
    async (daemonId: string, slug: string) => {
      try {
        const result = await rename.mutateAsync({
          data: { organizationSlug, daemonId, slug },
        });
        return result.status === "ok" && result.data.state === "complete";
      } catch {
        return false;
      }
    },
    [organizationSlug, rename],
  );
  const revokeSelected = useCallback(
    (daemonId: string) => revoke.mutate({ data: { organizationSlug, daemonId } }),
    [organizationSlug, revoke],
  );
  if (snapshot.isPending) return <DaemonLoading />;
  if (snapshot.isError || snapshot.data.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Daemons unavailable</AlertTitle>
        <AlertDescription>
          {snapshot.data?.status === "error"
            ? snapshot.data.error.message
            : "We couldn't load this organization's daemons."}
        </AlertDescription>
      </Alert>
    );
  }
  const daemons = snapshot.data.data;
  const failure = [rename.data, revoke.data].find((result) => result?.status === "error");
  let message = failure?.status === "error" ? failure.error.message : undefined;
  if (rename.isError || revoke.isError) message = "We couldn't update that daemon.";
  const busy = rename.isPending || revoke.isPending;
  return (
    <>
      <PageHeader
        id="daemons-heading"
        title="Daemons"
        description="Stable daemon identities registered to this organization."
      />
      {message === undefined ? null : (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <DataTable
        label="Daemons"
        columns={DAEMON_COLUMNS}
        isEmpty={daemons.daemons.length === 0}
        empty={DAEMONS_EMPTY}
      >
        {daemons.daemons.map((daemon) => (
          <DaemonRow
            key={daemon.id}
            daemon={daemon}
            canManage={daemons.canManage}
            busy={busy}
            onRename={renameSelected}
            onRevoke={revokeSelected}
          />
        ))}
      </DataTable>
    </>
  );
}

function DaemonRow({
  daemon,
  canManage,
  busy,
  onRename,
  onRevoke,
}: {
  daemon: BrowserDaemon;
  canManage: boolean;
  busy: boolean;
  onRename: (daemonId: string, slug: string) => Promise<boolean>;
  onRevoke: (daemonId: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const requestRename = useCallback((event: Event) => {
    event.preventDefault();
    setRenaming(true);
  }, []);
  const revoke = useCallback(() => onRevoke(daemon.id), [daemon.id, onRevoke]);

  return (
    <DataRow>
      <DataCell className="min-w-0">
        <span className="block truncate">{daemon.slug}</span>
      </DataCell>
      <DataCell muted>
        <span className="font-mono text-xs">{daemon.id.slice(0, 8)}</span>
      </DataCell>
      <DataCell>
        <DaemonStatus daemon={daemon} />
      </DataCell>
      <DataCell muted>{formatDate(daemon.lastSeenAt)}</DataCell>
      <DataCell muted>{formatDate(daemon.registeredAt)}</DataCell>
      <DataCell align="end">
        {canManage ? (
          <>
            <RowActions label={`Actions for ${daemon.slug}`}>
              <DropdownMenuItem disabled={busy} onSelect={requestRename}>
                Rename
              </DropdownMenuItem>
              {daemon.status === "revoked" ? null : (
                <ConfirmMenuItem
                  busy={busy}
                  destructive
                  label="Revoke"
                  title={`Revoke ${daemon.slug}?`}
                  description="The daemon will disconnect and its credential cannot reconnect."
                  cancelLabel="Cancel"
                  confirmLabel="Revoke daemon"
                  onConfirm={revoke}
                />
              )}
            </RowActions>
            <RenameDaemonDialog
              daemon={daemon}
              busy={busy}
              onRename={onRename}
              open={renaming}
              onOpenChange={setRenaming}
            />
          </>
        ) : null}
      </DataCell>
    </DataRow>
  );
}

function RenameDaemonDialog({
  daemon,
  busy,
  onRename,
  open,
  onOpenChange,
}: {
  daemon: BrowserDaemon;
  busy: boolean;
  onRename: (daemonId: string, slug: string) => Promise<boolean>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const completeRename = useCallback(
    async (slug: string) => {
      if (await onRename(daemon.id, slug)) onOpenChange(false);
    },
    [daemon.id, onOpenChange, onRename],
  );
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const slug = new FormData(event.currentTarget).get("slug");
      if (typeof slug !== "string") return;
      void completeRename(slug);
    },
    [completeRename],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename daemon</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={submit}
          aria-label={`Rename ${daemon.slug}`}
          className="grid gap-6 text-left"
        >
          <Field>
            <FieldLabel htmlFor={`daemon-slug-${daemon.id}`}>Daemon slug</FieldLabel>
            <Input
              id={`daemon-slug-${daemon.id}`}
              name="slug"
              defaultValue={daemon.slug}
              maxLength={100}
              required
              disabled={busy}
            />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DaemonStatus({ daemon }: { daemon: BrowserDaemon }) {
  if (daemon.status === "revoked") return <StatusPill tone="danger">Revoked</StatusPill>;
  if (daemon.presence === "connected") return <StatusPill tone="success">Connected</StatusPill>;
  return <StatusPill tone="neutral">Offline</StatusPill>;
}

function DaemonLoading() {
  return (
    <section aria-label="Loading daemons" className="grid gap-6">
      <Skeleton className="h-12 w-64" />
      <Skeleton className="h-64 w-full" />
    </section>
  );
}

/** Approval is a single focused task, so it sits in a narrow column inside the page. */
function CenteredPanel({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-lg py-8">{children}</div>;
}

function RegistrationComplete({
  decision,
  organizationSlug,
}: {
  decision: "approved" | "denied";
  organizationSlug: string;
}) {
  const daemonRouteParams = useMemo(() => ({ organizationSlug }), [organizationSlug]);
  return (
    <CenteredPanel>
      <AuthCard title={`Registration ${decision}`} description="You can return to the terminal.">
        <Button asChild variant="outline">
          <Link to="/o/$organizationSlug/daemons" params={daemonRouteParams}>
            Go to daemons
          </Link>
        </Button>
      </AuthCard>
    </CenteredPanel>
  );
}

export function RegistrationApproval({
  accountId,
  organizationId,
}: {
  accountId: string;
  organizationId: string;
}) {
  const [code, setCode] = useState(() =>
    typeof window === "undefined"
      ? undefined
      : (new URLSearchParams(window.location.search).get("code") ?? undefined),
  );
  const inspect = useServerFn(inspectRegistration);
  const snapshot = useQuery({
    queryKey: ["registration", accountId, organizationId, code],
    queryFn: () => inspect({ data: { userCode: code! } }),
    enabled: code !== undefined,
  });
  const decide = useMutation({
    mutationKey: DAEMON_MUTATION_KEY,
    mutationFn: useServerFn(decideRegistration) as (
      input: Parameters<typeof decideRegistration>[0],
    ) => Promise<Result<{ decision: "approved" | "denied" }>>,
  });
  const submitDecision = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (snapshot.data?.status !== "ok" || code === undefined) return;
      const data = new FormData(event.currentTarget);
      const slug = data.get("slug");
      const nativeEvent = event.nativeEvent;
      const submitter = "submitter" in nativeEvent ? nativeEvent.submitter : undefined;
      const value = submitter instanceof HTMLButtonElement ? submitter.value : "approve";
      if (typeof slug === "string" && (value === "approve" || value === "deny")) {
        decide.mutate({
          data: {
            userCode: code,
            decision: value,
            ...(value === "approve"
              ? { slug, organizationId: snapshot.data.data.organization.id }
              : {}),
          },
        });
      }
    },
    [code, decide, snapshot.data],
  );

  if (code !== undefined && snapshot.isPending) return <DaemonLoading />;
  if (snapshot.isError || snapshot.data?.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Registration unavailable</AlertTitle>
        <AlertDescription>
          {snapshot.data?.status === "error"
            ? snapshot.data.error.message
            : "This daemon registration request is unavailable."}
        </AlertDescription>
      </Alert>
    );
  }
  if (decide.data?.status === "ok" && snapshot.data?.status === "ok") {
    return (
      <RegistrationComplete
        decision={decide.data.data.decision}
        organizationSlug={snapshot.data.data.organization.slug}
      />
    );
  }
  if (code === undefined || snapshot.data === undefined) return <CodeEntry onCode={setCode} />;
  const request = snapshot.data.data;
  let message = decide.data?.status === "error" ? decide.data.error.message : undefined;
  if (decide.isError) message = "We couldn't decide this registration request.";

  return (
    <CenteredPanel>
      <AuthCard
        titleId="approval-heading"
        title="Approve daemon"
        description="Confirm that you started this request before granting access."
      >
        <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5 text-sm">
          <span className="text-muted-foreground">Organization</span>
          <span className="truncate">{request.organization.name}</span>
        </div>
        {request.canManage ? (
          <form className="grid gap-6" onSubmit={submitDecision} aria-label="Approve daemon">
            <Field>
              <FieldLabel htmlFor="registration-slug">Daemon slug</FieldLabel>
              <Input
                id="registration-slug"
                name="slug"
                defaultValue={request.slug}
                maxLength={100}
                required
                disabled={decide.isPending}
              />
              <FieldDescription>
                This slug is used in hub.yml and can be changed later.
              </FieldDescription>
            </Field>
            {message === undefined ? null : (
              <Alert variant="destructive">
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="submit"
                name="decision"
                value="deny"
                variant="outline"
                disabled={decide.isPending}
              >
                Deny
              </Button>
              <Button type="submit" name="decision" value="approve" disabled={decide.isPending}>
                Approve daemon
              </Button>
            </div>
          </form>
        ) : (
          <Alert>
            <AlertTitle>Approval required</AlertTitle>
            <AlertDescription>
              An organization owner or admin must decide this request.
            </AlertDescription>
          </Alert>
        )}
      </AuthCard>
    </CenteredPanel>
  );
}

function CodeEntry({ onCode }: { onCode: (code: string) => void }) {
  const submitCode = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const code = new FormData(event.currentTarget).get("code");
      if (typeof code === "string") {
        window.history.replaceState({}, "", `/activate?code=${encodeURIComponent(code)}`);
        onCode(code);
      }
    },
    [onCode],
  );

  return (
    <CenteredPanel>
      <AuthCard title="Register a daemon" description="Enter the code shown by the Paseo CLI.">
        <form className="grid gap-6" onSubmit={submitCode}>
          <Field>
            <FieldLabel htmlFor="registration-code">Verification code</FieldLabel>
            <Input id="registration-code" name="code" autoComplete="one-time-code" required />
          </Field>
          <Button type="submit">Continue</Button>
        </form>
      </AuthCard>
    </CenteredPanel>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
