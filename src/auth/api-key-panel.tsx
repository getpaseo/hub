import { KeyRound } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { EmptyState } from "../components/app/empty-state.js";
import { FailureAlert, WarningAlert, failureMessage } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { CopyField } from "../components/app/copy-field.js";
import { CheckboxField } from "../components/app/checkbox-field.js";
import { FormField } from "../components/app/form-field.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { RowActions } from "../components/app/row-actions.js";
import { Section } from "../components/app/section.js";
import { StatusPill } from "../components/app/status-pill.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { FieldDescription, FieldError } from "../components/ui/field.js";
import type { Result } from "../contract/respond.js";
import { apiKeyScopeSchema, type ApiKeyScope } from "./api-key-contract.js";
import { createApiKey, listApiKeys, revokeApiKey, revokeCliCredential } from "./functions.js";
import { useActiveAccount } from "./active-account.js";
import { API_KEY_MUTATION_KEY } from "./tenant-mutation.js";

interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface CliCredentialRecord {
  id: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

type ListResult = Result<{ keys: ApiKeyRecord[]; cliCredentials: CliCredentialRecord[] }>;
type CreateResult = Result<{ key: ApiKeyRecord; secret: string }>;

/**
 * Every failure on this page names what did not happen, because none of them are recoverable by
 * reading the list: a key that was not issued has no secret to recover, and a key that may or may
 * not have been revoked has to be checked.
 */
const LIST_FAILURE = "Hub did not receive the API-key list. Check your connection and reload.";
const CREATE_FAILURE =
  "Hub did not receive the API-key creation result. Check your connection and reload the key list; no secret can be recovered later.";
const REVOKE_FAILURE =
  "Hub did not receive the API-key revocation result. Check your connection and reload the key list to confirm its status.";

const SCOPE_OPTIONS = [
  {
    value: "projects:read",
    label: "List projects",
    description: "List active projects in the organization.",
  },
  {
    value: "configuration:validate",
    label: "Validate configuration",
    description: "Validate configuration without creating a revision.",
  },
  {
    value: "configuration:install",
    label: "Install configuration",
    description: "Replace and activate a project's configuration.",
  },
  {
    value: "runs:dispatch",
    label: "Start runs",
    description: "Dispatch manual runs for a project.",
  },
  {
    value: "daemons:enroll",
    label: "Enroll daemons",
    description: "Issue a daemon enrollment token.",
  },
] as const;

const TABLE_COLUMNS = [
  { header: "Name" },
  { header: "Prefix" },
  { header: "Scopes" },
  { header: "Created" },
  { header: "Last used" },
  { header: "Status" },
  { header: "", align: "end" as const },
];

const EMPTY_TABLE = {
  title: "No API keys",
  description:
    "Create a key to install configuration, start runs, or enroll daemons from automation.",
};
const EMPTY_CLI_TABLE = {
  title: "No CLI logins",
  description: "Run paseo hub login to create one.",
};
const CLI_COLUMNS = [
  { header: "Prefix" },
  { header: "Created" },
  { header: "Last used" },
  { header: "Status" },
  { header: "", align: "end" as const },
];

const CLI_LOGINS = {
  title: "CLI logins",
  description: "Durable terminal credentials created through browser approval.",
};

export function ApiKeys() {
  const account = useActiveAccount();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string>();
  const load = useServerFn(listApiKeys) as (
    input: Parameters<typeof listApiKeys>[0],
  ) => Promise<ListResult>;
  const snapshot = useQuery({
    queryKey: ["api-keys", account.organization.id],
    queryFn: () => load({}),
    enabled: account.capabilities.manageResources,
  });
  const create = useMutation({
    mutationKey: API_KEY_MUTATION_KEY,
    mutationFn: useServerFn(createApiKey) as (
      input: Parameters<typeof createApiKey>[0],
    ) => Promise<CreateResult>,
    onSuccess: (result) => {
      if (result.status === "ok") setSecret(result.data.secret);
    },
  });
  const revoke = useMutation({
    mutationKey: API_KEY_MUTATION_KEY,
    mutationFn: useServerFn(revokeApiKey) as (
      input: Parameters<typeof revokeApiKey>[0],
    ) => Promise<Result<Record<string, never>>>,
    onSuccess: async (result) => {
      if (result.status === "ok") {
        await queryClient.invalidateQueries({ queryKey: ["api-keys", account.organization.id] });
      }
    },
  });
  const revokeCli = useMutation({
    mutationKey: API_KEY_MUTATION_KEY,
    mutationFn: useServerFn(revokeCliCredential) as (
      input: Parameters<typeof revokeCliCredential>[0],
    ) => Promise<Result<Record<string, never>>>,
    onSuccess: async (result) => {
      if (result.status === "ok") {
        await queryClient.invalidateQueries({ queryKey: ["api-keys", account.organization.id] });
      }
    },
  });
  const openCreate = useCallback(() => setCreating(true), []);
  const reload = useCallback(() => void snapshot.refetch(), [snapshot]);
  const close = useCallback(
    (open: boolean) => {
      setCreating(open);
      if (!open) {
        setSecret(undefined);
        create.reset();
        void queryClient.invalidateQueries({ queryKey: ["api-keys", account.organization.id] });
      }
    },
    [account.organization.id, create, queryClient],
  );
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const nameValue = form.get("name");
      const name = typeof nameValue === "string" ? nameValue : "";
      const scopes = form.getAll("scopes").flatMap((value): ApiKeyScope[] => {
        if (typeof value !== "string") return [];
        const parsed = apiKeyScopeSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      });
      create.mutate({ data: { name, scopes } });
    },
    [create],
  );
  const header = (
    <PageHeader title="API keys" description={`Machine access for ${account.organization.name}.`}>
      <Button asChild variant="outline">
        <a href="https://paseo.sh/docs/hub/api">API reference</a>
      </Button>
      {account.capabilities.manageResources ? (
        <Button type="button" onClick={openCreate}>
          <KeyRound aria-hidden="true" />
          Create API key
        </Button>
      ) : null}
    </PageHeader>
  );
  if (!account.capabilities.manageResources) {
    return (
      <>
        {header}
        <EmptyState
          title="No access to API keys"
          description="You don't have permission to manage API keys."
        />
      </>
    );
  }
  if (snapshot.isPending) {
    return (
      <>
        {header}
        <Section>
          <DataTableSkeleton label="API keys" columns={TABLE_COLUMNS} />
        </Section>
        <Section title={CLI_LOGINS.title} description={CLI_LOGINS.description}>
          <DataTableSkeleton label="CLI logins" columns={CLI_COLUMNS} rows={1} />
        </Section>
      </>
    );
  }
  if (snapshot.isError || snapshot.data.status === "error") {
    return (
      <>
        {header}
        <FailureAlert
          title="API keys unavailable"
          error={snapshot.data}
          fallback={LIST_FAILURE}
          onRetry={reload}
        />
      </>
    );
  }
  const keys = [...snapshot.data.data.keys].sort((left, right) => {
    const revoked = Number(left.revokedAt !== null) - Number(right.revokedAt !== null);
    return revoked || right.createdAt.localeCompare(left.createdAt);
  });
  const cliCredentials = [...snapshot.data.data.cliCredentials].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  const createError =
    create.isError || create.data?.status === "error"
      ? failureMessage(create.data, CREATE_FAILURE)
      : undefined;
  const revokeError =
    revoke.isError || revoke.data?.status === "error"
      ? failureMessage(revoke.data, REVOKE_FAILURE)
      : undefined;
  return (
    <>
      {header}
      <Section>
        {revokeError === undefined ? null : (
          <FailureAlert title="API key not revoked" error={revokeError} fallback={REVOKE_FAILURE} />
        )}
        <DataTable
          label="API keys"
          columns={TABLE_COLUMNS}
          isEmpty={keys.length === 0}
          empty={EMPTY_TABLE}
        >
          {keys.map((record) => (
            <ApiKeyRow
              key={record.id}
              record={record}
              canManage={account.capabilities.manageResources}
              busy={revoke.isPending}
              onRevoke={revoke.mutate}
            />
          ))}
        </DataTable>
      </Section>
      <Section title={CLI_LOGINS.title} description={CLI_LOGINS.description}>
        <DataTable
          label="CLI logins"
          columns={CLI_COLUMNS}
          isEmpty={cliCredentials.length === 0}
          empty={EMPTY_CLI_TABLE}
        >
          {cliCredentials.map((record) => (
            <CliCredentialRow
              key={record.id}
              record={record}
              busy={revokeCli.isPending}
              onRevoke={revokeCli.mutate}
            />
          ))}
        </DataTable>
      </Section>
      <ApiKeyDialog
        open={creating}
        onOpenChange={close}
        secret={secret}
        busy={create.isPending}
        error={createError}
        onSubmit={submit}
      />
    </>
  );
}

function CliCredentialRow({
  record,
  busy,
  onRevoke,
}: {
  record: CliCredentialRecord;
  busy: boolean;
  onRevoke: (input: { data: { id: string } }) => void;
}) {
  const revoke = useCallback(() => onRevoke({ data: { id: record.id } }), [onRevoke, record.id]);
  return (
    <DataRow>
      <DataCell>
        <span className="font-mono text-xs">{record.prefix}</span>
      </DataCell>
      <DataCell muted>
        <RelativeTime value={record.createdAt} />
      </DataCell>
      <DataCell muted>
        {record.lastUsedAt === null ? "Never" : <RelativeTime value={record.lastUsedAt} />}
      </DataCell>
      <DataCell>
        <StatusPill tone={record.revokedAt === null ? "success" : "danger"}>
          {record.revokedAt === null ? "Active" : "Revoked"}
        </StatusPill>
      </DataCell>
      <DataCell align="end">
        {record.revokedAt === null ? (
          <RowActions label={`Actions for ${record.prefix}`}>
            <ConfirmMenuItem
              label="Revoke"
              destructive
              title="Revoke CLI login?"
              description="This terminal credential stops working immediately."
              confirmLabel="Revoke login"
              cancelLabel="Cancel"
              busy={busy}
              onConfirm={revoke}
            />
          </RowActions>
        ) : null}
      </DataCell>
    </DataRow>
  );
}

function ApiKeyRow({
  record,
  canManage,
  busy,
  onRevoke,
}: {
  record: ApiKeyRecord;
  canManage: boolean;
  busy: boolean;
  onRevoke: (input: { data: { id: string } }) => void;
}) {
  const revoke = useCallback(() => onRevoke({ data: { id: record.id } }), [onRevoke, record.id]);
  return (
    <DataRow>
      <DataCell>{record.name}</DataCell>
      <DataCell>
        <span className="font-mono text-xs">{record.prefix}</span>
      </DataCell>
      <DataCell muted>{record.scopes.map(scopeLabel).join(", ")}</DataCell>
      <DataCell muted>
        <RelativeTime value={record.createdAt} />
      </DataCell>
      <DataCell muted>
        {record.lastUsedAt === null ? "Never" : <RelativeTime value={record.lastUsedAt} />}
      </DataCell>
      <DataCell>
        <StatusPill tone={record.revokedAt === null ? "success" : "danger"}>
          {record.revokedAt === null ? "Active" : "Revoked"}
        </StatusPill>
      </DataCell>
      <DataCell align="end">
        {record.revokedAt === null && canManage ? (
          <RowActions label={`Actions for ${record.name}`}>
            <ConfirmMenuItem
              label="Revoke"
              destructive
              title={`Revoke ${record.name}?`}
              description="Any automation using this key stops working immediately. This cannot be undone."
              confirmLabel="Revoke key"
              cancelLabel="Cancel"
              busy={busy}
              onConfirm={revoke}
            />
          </RowActions>
        ) : null}
      </DataCell>
    </DataRow>
  );
}

function ApiKeyDialog({
  open,
  onOpenChange,
  secret,
  busy,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secret: string | undefined;
  busy: boolean;
  error: string | undefined;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [selectedScopes, setSelectedScopes] = useState(0);
  const [scopeError, setScopeError] = useState<string>();
  const updateScope = useCallback((checked: boolean) => {
    setSelectedScopes((count) => count + (checked ? 1 : -1));
  }, []);
  useEffect(() => {
    if (!open) {
      setSelectedScopes(0);
      setScopeError(undefined);
    }
  }, [open]);
  // A key with no scopes can do nothing, and the server refuses it. Say so where the choice is
  // rather than greying out the submit, which explains nothing to whoever clicks it.
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      if (selectedScopes === 0) {
        event.preventDefault();
        setScopeError("Select at least one scope.");
        return;
      }
      setScopeError(undefined);
      onSubmit(event);
    },
    [onSubmit, selectedScopes],
  );

  if (secret !== undefined) {
    return <SecretDialog open={open} onOpenChange={onOpenChange} secret={secret} />;
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create API key"
      description="Choose the machine operations this organization key can perform."
      label="Create API key"
      submitLabel="Create API key"
      busy={busy}
      onSubmit={submit}
    >
      <FormField kind="text" id="api-key-name" name="name" label="Name" required />
      <fieldset className="grid gap-3">
        <legend>Scopes</legend>
        <div className="grid gap-3">
          {SCOPE_OPTIONS.map((option) => (
            <ScopeOption key={option.value} option={option} onChange={updateScope} />
          ))}
        </div>
        {scopeError === undefined ? (
          <FieldDescription>Select at least one scope.</FieldDescription>
        ) : (
          <FieldError>{scopeError}</FieldError>
        )}
      </fieldset>
      {error === undefined ? null : (
        <FailureAlert title="API key not created" error={error} fallback={CREATE_FAILURE} />
      )}
    </FormDialog>
  );
}

/**
 * The key itself, once. The dialog cannot be dismissed by escape or by clicking away while it is
 * on screen, and the value takes focus already selected, because closing it is the one action
 * that destroys the secret for good.
 */
function SecretDialog({
  open,
  onOpenChange,
  secret,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secret: string;
}) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const preventDismissal = useCallback((event: { preventDefault: () => void }) => {
    event.preventDefault();
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={preventDismissal}
        onPointerDownOutside={preventDismissal}
      >
        <DialogHeader>
          <DialogTitle>Copy your API key</DialogTitle>
          <DialogDescription>
            This key is shown once. Store it in your deployment secrets now.
          </DialogDescription>
        </DialogHeader>
        <WarningAlert title="Save this key now">
          This secret cannot be recovered after you close this dialog.
        </WarningAlert>
        <CopyField label="Generated API key" value={secret} copyLabel="Copy API key" focusOnMount />
        <FormActions>
          <Button type="button" onClick={close}>
            Done
          </Button>
        </FormActions>
      </DialogContent>
    </Dialog>
  );
}

function scopeLabel(scope: ApiKeyScope): string {
  return SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? scope;
}

/** A scope, its consequence, and the box that grants it. */
function ScopeOption({
  option,
  onChange,
}: {
  option: (typeof SCOPE_OPTIONS)[number];
  onChange: (checked: boolean) => void;
}) {
  return (
    <CheckboxField
      id={`api-key-scope-${option.value}`}
      name="scopes"
      value={option.value}
      label={option.label}
      description={option.description}
      onChange={onChange}
    />
  );
}
