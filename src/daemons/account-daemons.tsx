import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useState, type FormEvent } from "react";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import { Field, FieldLabel } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Skeleton } from "../components/ui/skeleton.js";
import {
  daemonList,
  grantDaemonAccess,
  renameDaemon,
  revokeDaemonAccess,
  revokeDaemon,
  type BrowserDaemon,
  type BrowserDaemonAccessGrant,
  type BrowserDaemonAccessRole,
  type DaemonCommand,
} from "./functions.js";
import type { Result } from "../contract/respond.js";
import { DAEMON_MUTATION_KEY } from "../auth/tenant-mutation.js";
import { daemonsQueryKey, refreshDaemons } from "./status.js";
import type { TeamMember } from "../auth/organization-contract.js";

const DAEMON_COLUMNS: readonly DataColumn[] = [
  { header: "Slug" },
  { header: "ID" },
  { header: "Status" },
  { header: "Access" },
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
  members,
}: {
  accountId: string;
  organizationId: string;
  organizationSlug: string;
  members: readonly TeamMember[];
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
  const grantAccess = useMutation({
    mutationKey: DAEMON_MUTATION_KEY,
    mutationFn: useServerFn(grantDaemonAccess) as (
      input: Parameters<typeof grantDaemonAccess>[0],
    ) => Promise<Result<DaemonCommand>>,
    onSuccess: async (result) => {
      if (result.status === "ok" && result.data.state === "complete") {
        await refreshDaemons(queryClient, accountId, organizationId);
      }
    },
  });
  const revokeAccess = useMutation({
    mutationKey: DAEMON_MUTATION_KEY,
    mutationFn: useServerFn(revokeDaemonAccess) as (
      input: Parameters<typeof revokeDaemonAccess>[0],
    ) => Promise<Result<DaemonCommand>>,
    onSuccess: async (result) => {
      if (result.status === "ok" && result.data.state === "complete") {
        await refreshDaemons(queryClient, accountId, organizationId);
      }
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
  const grantSelected = useCallback(
    async (daemonId: string, memberId: string, role: BrowserDaemonAccessRole) => {
      try {
        const result = await grantAccess.mutateAsync({
          data: { organizationSlug, daemonId, memberId, role },
        });
        return result.status === "error" ? result.error.message : undefined;
      } catch {
        return "Hub did not receive the access update. Reload and try again.";
      }
    },
    [grantAccess, organizationSlug],
  );
  const revokeAccessSelected = useCallback(
    async (daemonId: string, memberId: string) => {
      try {
        const result = await revokeAccess.mutateAsync({
          data: { organizationSlug, daemonId, memberId },
        });
        return result.status === "error" ? result.error.message : undefined;
      } catch {
        return "Hub did not receive the access revocation. Reload and try again.";
      }
    },
    [organizationSlug, revokeAccess],
  );
  if (snapshot.isPending) return <DaemonLoading />;
  if (snapshot.isError || snapshot.data.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Daemons unavailable</AlertTitle>
        <AlertDescription>
          {snapshot.data?.status === "error"
            ? snapshot.data.error.message
            : "Hub did not receive the daemon list. Check your connection and reload the page."}
        </AlertDescription>
      </Alert>
    );
  }
  const daemons = snapshot.data.data;
  const failure = [revoke.data, grantAccess.data, revokeAccess.data].find(
    (result) => result?.status === "error",
  );
  let message = failure?.status === "error" ? failure.error.message : undefined;
  if (revoke.isError)
    message =
      "Hub did not receive the daemon revocation result. Check your connection and reload its current status.";
  const busy =
    rename.isPending || revoke.isPending || grantAccess.isPending || revokeAccess.isPending;
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
            grants={daemons.grants}
            members={members}
            canManage={daemons.canManage}
            busy={busy}
            onRename={renameSelected}
            onRevoke={revokeSelected}
            onGrantAccess={grantSelected}
            onRevokeAccess={revokeAccessSelected}
          />
        ))}
      </DataTable>
    </>
  );
}

function DaemonRow({
  daemon,
  grants,
  members,
  canManage,
  busy,
  onRename,
  onRevoke,
  onGrantAccess,
  onRevokeAccess,
}: {
  daemon: BrowserDaemon;
  grants: readonly BrowserDaemonAccessGrant[];
  members: readonly TeamMember[];
  canManage: boolean;
  busy: boolean;
  onRename: (daemonId: string, slug: string) => Promise<string | undefined>;
  onRevoke: (daemonId: string) => void;
  onGrantAccess: (
    daemonId: string,
    memberId: string,
    role: BrowserDaemonAccessRole,
  ) => Promise<string | undefined>;
  onRevokeAccess: (daemonId: string, memberId: string) => Promise<string | undefined>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [managingAccess, setManagingAccess] = useState(false);
  const daemonGrants = useMemo(
    () => grants.filter((grant) => grant.daemonId === daemon.id),
    [daemon.id, grants],
  );
  const requestRename = useCallback((event: Event) => {
    event.preventDefault();
    setRenaming(true);
  }, []);
  const revoke = useCallback(() => onRevoke(daemon.id), [daemon.id, onRevoke]);
  const manageAccess = useCallback(() => setManagingAccess(true), []);

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
      <DataCell>
        {canManage ? (
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={manageAccess}>
            {daemonGrants.length === 1 ? "1 member" : `${daemonGrants.length} members`}
          </Button>
        ) : (
          <span className="text-sm capitalize">{daemonGrants[0]?.role ?? "Viewer"}</span>
        )}
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
            <DaemonAccessDialog
              daemon={daemon}
              grants={daemonGrants}
              members={members}
              busy={busy}
              open={managingAccess}
              onOpenChange={setManagingAccess}
              onGrant={onGrantAccess}
              onRevoke={onRevokeAccess}
            />
          </>
        ) : null}
      </DataCell>
    </DataRow>
  );
}

function DaemonAccessDialog({
  daemon,
  grants,
  members,
  busy,
  open,
  onOpenChange,
  onGrant,
  onRevoke,
}: {
  daemon: BrowserDaemon;
  grants: readonly BrowserDaemonAccessGrant[];
  members: readonly TeamMember[];
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGrant: (
    daemonId: string,
    memberId: string,
    role: BrowserDaemonAccessRole,
  ) => Promise<string | undefined>;
  onRevoke: (daemonId: string, memberId: string) => Promise<string | undefined>;
}) {
  const [error, setError] = useState<string>();
  const update = useCallback(
    async (memberId: string, role: BrowserDaemonAccessRole) => {
      setError(await onGrant(daemon.id, memberId, role));
    },
    [daemon.id, onGrant],
  );
  const remove = useCallback(
    async (memberId: string) => {
      setError(await onRevoke(daemon.id, memberId));
    },
    [daemon.id, onRevoke],
  );
  const changeOpen = useCallback(
    (next: boolean) => {
      if (!next) setError(undefined);
      onOpenChange(next);
    },
    [onOpenChange],
  );
  const close = useCallback(() => changeOpen(false), [changeOpen]);
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Access to {daemon.slug}</DialogTitle>
          <DialogDescription>
            Members only see daemon spaces assigned to them. Roles are recorded now and will sync to
            native pairing when Paseo exposes scoped principals.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {members.map((member) => (
            <MemberAccessRow
              key={member.id}
              member={member}
              grant={grants.find((candidate) => candidate.memberId === member.id)}
              busy={busy}
              onUpdate={update}
              onRemove={remove}
            />
          ))}
        </div>
        {error === undefined ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberAccessRow({
  member,
  grant,
  busy,
  onUpdate,
  onRemove,
}: {
  member: TeamMember;
  grant: BrowserDaemonAccessGrant | undefined;
  busy: boolean;
  onUpdate: (memberId: string, role: BrowserDaemonAccessRole) => Promise<void>;
  onRemove: (memberId: string) => Promise<void>;
}) {
  const change = useCallback(
    (value: string) => {
      if (value === "none") {
        if (grant !== undefined) void onRemove(member.id);
        return;
      }
      if (isAccessRole(value)) void onUpdate(member.id, value);
    },
    [grant, member.id, onRemove, onUpdate],
  );
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{member.name}</div>
        <div className="truncate text-xs text-muted-foreground">{member.email}</div>
      </div>
      <Select value={grant?.role ?? "none"} disabled={busy} onValueChange={change}>
        <SelectTrigger size="sm" aria-label={`Access for ${member.name}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No access</SelectItem>
          <SelectItem value="viewer">Viewer</SelectItem>
          <SelectItem value="operator">Operator</SelectItem>
          <SelectItem value="owner">Owner</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function isAccessRole(value: string): value is BrowserDaemonAccessRole {
  return value === "owner" || value === "operator" || value === "viewer";
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
    <Dialog open={open} onOpenChange={changeOpen}>
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
          {error === undefined ? null : (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
