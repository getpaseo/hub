import { Plus } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { DataCell, DataRow, DataTable, type DataColumn } from "../components/app/data-table.js";
import { PageHeader } from "../components/app/page.js";
import { RowActions } from "../components/app/row-actions.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { Section } from "../components/app/section.js";
import { StatusLine } from "../components/app/status-line.js";
import { StatusPill } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import type { ActiveAccountState, TeamMember } from "./organization-contract.js";
import { formValue, invitationRole } from "./account-actions.js";
import { FormField, type FieldControl } from "../components/app/form-field.js";
import { useActiveAccount } from "./active-account.js";
import { cancelInvitation, changeMemberRole, createInvitation, removeMember } from "./functions.js";
import type { Result } from "../contract/respond.js";
import { ACCOUNT_MUTATION_KEY, useAccountMutationPending } from "./account-mutation.js";
import type { UsageLimitsView } from "../usage/dashboard.js";
import { atLimit, LockedAction, useOrganizationLimits } from "../entitlements/ui/index.js";

type AccountCommandResult = Result<{
  state: "sessionExpired" | "organizationRequired" | "complete";
}>;
import {
  INVITATION_ROLES,
  ORGANIZATION_ROLES,
  invitationRoleSchema,
  organizationRoleSchema,
  type InvitationRole,
  type OrganizationRole,
} from "./organization-contract.js";

const EMPTY_INVITATIONS: NonNullable<ActiveAccountState["team"]["invitations"]> = [];
const INVITATION_ROLE_LABELS = {
  admin: "Admin",
  member: "Member",
} satisfies Record<InvitationRole, string>;
const ORGANIZATION_ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
} satisfies Record<OrganizationRole, string>;
type ActiveAccount = ActiveAccountState & { busy: boolean };

const MEMBER_COLUMNS: readonly DataColumn[] = [
  { header: "Member" },
  { header: "Role" },
  { header: "", align: "end" },
];
const MEMBERS_EMPTY = {
  title: "No members",
  description: "This organization has no members yet.",
};
const INVITATION_COLUMNS: readonly DataColumn[] = [
  { header: "Invitee" },
  { header: "Role" },
  { header: "", align: "end" },
];
const INVITATIONS_EMPTY = {
  title: "No pending invitations",
  description: "New invitations appear here.",
};

export function Team() {
  const account = useActiveAccount();
  const [inviting, setInviting] = useState(false);
  const invite = useCallback(() => setInviting(true), []);
  const busy = useAccountMutationPending();
  const limits = useOrganizationLimits(account.capabilities.manageMembers);
  const limit = limits === undefined ? null : inviteLimit(limits);
  const activeAccount = useMemo(() => ({ ...account, busy }), [account, busy]);

  return (
    <>
      <PageHeader
        id="team-heading"
        title="Team"
        description={`People with access to ${account.organization.name}.`}
      >
        {account.capabilities.manageMembers && (
          <LockedAction
            limit={limit}
            label="Invite member"
            icon={Plus}
            onPress={invite}
            busy={busy}
          />
        )}
      </PageHeader>
      <Section title="Members">
        <MembersTable account={activeAccount} />
      </Section>
      {account.capabilities.manageMembers && (
        <Section title="Pending invitations">
          <InvitationList
            invitations={account.team.invitations ?? EMPTY_INVITATIONS}
            busy={busy}
            organizationName={account.organization.name}
          />
        </Section>
      )}
      {account.capabilities.manageMembers && (
        <InvitationDialog open={inviting} onOpenChange={setInviting} busy={busy} />
      )}
    </>
  );
}

/**
 * The limit the organization has run into, or null while it may still invite. The flag is
 * reported ahead of the seat cap: an organization with invitations turned off is not short of
 * seats.
 */
function inviteLimit(limits: UsageLimitsView): string | null {
  if (!limits.canInviteMembers) return "Inviting members isn't enabled for this organization.";
  const { seats } = limits;
  if (!atLimit(seats)) return null;
  return `Seat limit reached — ${seats.used} of ${seats.limit} seats are in use.`;
}

function InvitationDialog({
  open,
  onOpenChange,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
}) {
  const [role, setRole] = useState<InvitationRole>(INVITATION_ROLES[1]);
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: useServerFn(createInvitation) as (
      input: Parameters<typeof createInvitation>[0],
    ) => Promise<AccountCommandResult>,
    onSuccess: async (result) => {
      if (result.status === "ok") await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      create.mutate({
        data: { email: formValue(data, "email"), role: invitationRole(data) },
      });
      setRole(INVITATION_ROLES[1]);
      onOpenChange(false);
    },
    [create, onOpenChange],
  );

  const selectRole = useCallback((value: string): void => {
    setRole(invitationRoleSchema.parse(value));
  }, []);

  const roleControl = useCallback(
    (control: FieldControl) => (
      <Select name="role" value={role} onValueChange={selectRole} required>
        <SelectTrigger {...control} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {INVITATION_ROLES.map((roleValue) => (
            <SelectItem value={roleValue} key={roleValue}>
              {INVITATION_ROLE_LABELS[roleValue]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ),
    [role, selectRole],
  );

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Invite a team member"
      description="Create a role-bound invitation link for a teammate."
      label="Invite team member"
      submitLabel="Create invitation"
      busy={busy}
      onSubmit={submit}
    >
      <FormField label="Invitee email" name="email" id="invite-email" kind="email" required />
      <FormField id="invite-role" label="Role">
        {roleControl}
      </FormField>
    </FormDialog>
  );
}

function MembersTable({ account }: { account: ActiveAccount }) {
  return (
    <DataTable
      label="Members"
      columns={MEMBER_COLUMNS}
      isEmpty={account.team.members.length === 0}
      empty={MEMBERS_EMPTY}
    >
      {account.team.members.map((member) => (
        <MemberRow account={account} member={member} key={member.id} />
      ))}
    </DataTable>
  );
}

function MemberRow({ account, member }: { account: ActiveAccount; member: TeamMember }) {
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: useServerFn(changeMemberRole) as (
      input: Parameters<typeof changeMemberRole>[0],
    ) => Promise<AccountCommandResult>,
    onSuccess: async (result) => {
      if (result.status === "ok") await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const removeMemberMutation = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: useServerFn(removeMember) as (
      input: Parameters<typeof removeMember>[0],
    ) => Promise<AccountCommandResult>,
    onSuccess: async (result) => {
      if (result.status === "ok") await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const canManage =
    account.capabilities.manageMembers &&
    (member.role !== "owner" || account.capabilities.manageOwners);
  const changeRole = useCallback(
    (value: string) => {
      change.mutate({
        data: { memberId: member.id, role: organizationRoleSchema.parse(value) },
      });
    },
    [change, member.id],
  );
  const remove = useCallback(() => {
    removeMemberMutation.mutate({ data: { memberId: member.id } });
  }, [member.id, removeMemberMutation]);

  return (
    <DataRow>
      <DataCell className="min-w-0">
        <TwoLine primary={member.name} secondary={member.email} />
      </DataCell>
      <DataCell>
        {canManage ? (
          <Select
            key={`${member.id}:${member.role}`}
            value={member.role}
            onValueChange={changeRole}
            disabled={account.busy}
          >
            <SelectTrigger size="sm" aria-label={`Role for ${member.name}`} className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORGANIZATION_ROLES.filter(
                (role) => role !== "owner" || account.capabilities.manageOwners,
              ).map((role) => (
                <SelectItem value={role} key={role}>
                  {ORGANIZATION_ROLE_LABELS[role]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <StatusPill tone="neutral" dot={false}>
            {ORGANIZATION_ROLE_LABELS[member.role]}
          </StatusPill>
        )}
      </DataCell>
      <DataCell align="end">
        {canManage ? (
          <RowActions label={`Actions for ${member.name}`}>
            <ConfirmMenuItem
              busy={account.busy}
              destructive
              label={`Remove ${member.name}`}
              title={`Remove ${member.name}?`}
              description={`${member.name} will immediately lose access to ${account.organization.name}. This action cannot be undone.`}
              cancelLabel="Keep member"
              confirmLabel={`Remove ${member.name}`}
              onConfirm={remove}
            />
          </RowActions>
        ) : null}
      </DataCell>
    </DataRow>
  );
}

function InvitationList({
  invitations,
  busy,
  organizationName,
}: {
  invitations: NonNullable<ActiveAccountState["team"]["invitations"]>;
  busy: boolean;
  organizationName: string;
}) {
  const [copyStatus, setCopyStatus] = useState<string>();

  return (
    <>
      <DataTable
        label="Pending invitations"
        columns={INVITATION_COLUMNS}
        isEmpty={invitations.length === 0}
        empty={INVITATIONS_EMPTY}
      >
        {invitations.map((invitation) => (
          <DataRow key={invitation.id}>
            <DataCell className="min-w-0">
              <TwoLine primary={invitation.email} />
            </DataCell>
            <DataCell>
              <StatusPill tone="neutral" dot={false}>
                {ORGANIZATION_ROLE_LABELS[invitation.role]}
              </StatusPill>
            </DataCell>
            <DataCell align="end">
              <InvitationActions
                id={invitation.id}
                email={invitation.email}
                link={invitation.link}
                organizationName={organizationName}
                busy={busy}
                onCopyStatusChange={setCopyStatus}
              />
            </DataCell>
          </DataRow>
        ))}
      </DataTable>
      <StatusLine>{copyStatus}</StatusLine>
    </>
  );
}

function InvitationActions({
  id,
  email,
  link,
  organizationName,
  busy,
  onCopyStatusChange,
}: {
  id: string;
  email: string;
  link: string;
  organizationName: string;
  busy: boolean;
  onCopyStatusChange: (status: string) => void;
}) {
  const queryClient = useQueryClient();
  const cancelInvitationMutation = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: useServerFn(cancelInvitation) as (
      input: Parameters<typeof cancelInvitation>[0],
    ) => Promise<AccountCommandResult>,
    onSuccess: async (result) => {
      if (result.status === "ok") await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const cancel = useCallback(() => {
    cancelInvitationMutation.mutate({ data: { invitationId: id } });
  }, [cancelInvitationMutation, id]);
  const copy = useCallback((): void => {
    void navigator.clipboard.writeText(link).then(
      () => onCopyStatusChange("Invitation link copied."),
      () =>
        onCopyStatusChange(
          "Clipboard access was blocked. Open the invitation menu and copy the link manually.",
        ),
    );
  }, [link, onCopyStatusChange]);

  return (
    <RowActions label={`Actions for ${email}`}>
      <DropdownMenuItem onSelect={copy}>Copy link</DropdownMenuItem>
      <ConfirmMenuItem
        busy={busy}
        destructive
        label="Cancel invitation"
        title={`Cancel invitation for ${email}?`}
        description={`${email} will no longer be able to use this invitation to join ${organizationName}.`}
        cancelLabel="Keep invitation"
        confirmLabel="Cancel invitation"
        onConfirm={cancel}
      />
    </RowActions>
  );
}
