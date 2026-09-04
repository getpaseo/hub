import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BookOpen } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { CopyField } from "../components/app/copy-field.js";
import {
  DataCell,
  DataRow,
  DataTable,
  DataTableSkeleton,
  type DataColumn,
} from "../components/app/data-table.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { FormField } from "../components/app/form-field.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { RowActions } from "../components/app/row-actions.js";
import { StatusPill } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import {
  daemonList,
  renameDaemon,
  revokeDaemon,
  type BrowserDaemon,
  type DaemonCommand,
} from "./functions.js";
import type { Result } from "../contract/respond.js";
import { DAEMON_MUTATION_KEY } from "../auth/tenant-mutation.js";
import { daemonLoginCommand } from "./handoff.js";
import { daemonsQueryKey, refreshDaemons } from "./status.js";

const DAEMON_COLUMNS: readonly DataColumn[] = [
  { header: "Slug" },
  { header: "ID" },
  { header: "Status" },
  { header: "Access" },
  { header: "Last seen" },
  { header: "Registered" },
  { header: "", align: "end" },
];
const DAEMONS_DESCRIPTION = "Stable daemon identities registered to this organization.";
const DAEMON_DOCS_URL = "https://paseo.sh/docs/hub/daemons";
const DAEMONS_EMPTY = {
  title: "No daemons connected",
  description:
    "Hub runs your workflows on machines you own. Log in from the machine where your code lives and the CLI offers to connect it.",
  // A command is a value, and a centred value is a value nobody can scan.
  align: "start",
  action: <ConnectDaemonHint />,
} as const;

/**
 * The same handoff the operator saw during setup, for the operator who skipped it: the exact
 * command with this Hub's address already in it, and the page that explains the rest.
 */
function ConnectDaemonHint() {
  // The address the operator reached this Hub at is the address their daemon has to be told.
  // An empty table is only reached after a client-side query settles, so there is no server
  // render standing between this and a window.
  const origin = typeof window === "undefined" ? undefined : window.location.origin;
  return (
    <>
      {origin === undefined ? null : (
        <CopyField label="Command" value={daemonLoginCommand(origin)} />
      )}
      <Button asChild variant="outline" size="sm">
        <a href={DAEMON_DOCS_URL} target="_blank" rel="noreferrer">
          <BookOpen aria-hidden="true" />
          How to connect a daemon
        </a>
      </Button>
    </>
  );
}

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
        if (result.status === "error") return result.error.message;
        return result.data.state === "complete"
          ? undefined
          : "The daemon is no longer available in the current organization. Reload the daemon list.";
      } catch {
        return "Hub did not receive the daemon rename result. Check your connection and reload its current name.";
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
      <FailureAlert
        title="Daemons unavailable"
        error={snapshot.data}
        fallback="Hub did not receive the daemon list. Check your connection and reload the page."
      />
    );
  }
  const daemons = snapshot.data.data;
  const revokeFailed = revoke.isError || revoke.data?.status === "error";
  const busy = rename.isPending || revoke.isPending;
  return (
    <>
      <PageHeader id="daemons-heading" title="Daemons" description={DAEMONS_DESCRIPTION} />
      {revokeFailed ? (
        <FailureAlert
          standalone
          title="The daemon wasn't revoked"
          error={revoke.data}
          fallback="Hub did not receive the daemon revocation result. Check your connection and reload its current status."
        />
      ) : null}
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
  onRename: (daemonId: string, slug: string) => Promise<string | undefined>;
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
        <TwoLine primary={daemon.slug} />
      </DataCell>
      <DataCell muted>
        <span className="font-mono text-xs">{daemon.id.slice(0, 8)}</span>
      </DataCell>
      <DataCell>
        <DaemonStatus daemon={daemon} />
      </DataCell>
      <DataCell muted>
        {daemon.permissions.includes("hub.execute") ? "Hub automations" : "Connected only"}
      </DataCell>
      <DataCell muted>
        <RelativeTime value={daemon.lastSeenAt} />
      </DataCell>
      <DataCell muted>
        <RelativeTime value={daemon.registeredAt} />
      </DataCell>
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
  onRename: (daemonId: string, slug: string) => Promise<string | undefined>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string>();
  const changeOpen = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setError(undefined);
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );
  const completeRename = useCallback(
    async (slug: string) => {
      const failure = await onRename(daemon.id, slug);
      setError(failure);
      if (failure === undefined) changeOpen(false);
    },
    [changeOpen, daemon.id, onRename],
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
    <FormDialog
      open={open}
      onOpenChange={changeOpen}
      title="Rename daemon"
      label={`Rename ${daemon.slug}`}
      submitLabel="Rename"
      busy={busy}
      onSubmit={submit}
    >
      <FormField
        id={`daemon-slug-${daemon.id}`}
        label="Daemon slug"
        kind="text"
        name="slug"
        defaultValue={daemon.slug}
        maxLength={100}
        required
        {...(error === undefined ? {} : { error })}
      />
    </FormDialog>
  );
}

function DaemonStatus({ daemon }: { daemon: BrowserDaemon }) {
  if (daemon.status === "revoked") return <StatusPill tone="danger">Revoked</StatusPill>;
  if (daemon.presence === "connected") return <StatusPill tone="success">Connected</StatusPill>;
  return <StatusPill tone="neutral">Offline</StatusPill>;
}

function DaemonLoading() {
  return (
    <>
      <PageHeader id="daemons-heading" title="Daemons" description={DAEMONS_DESCRIPTION} />
      <DataTableSkeleton label="Daemons" columns={DAEMON_COLUMNS} />
    </>
  );
}
