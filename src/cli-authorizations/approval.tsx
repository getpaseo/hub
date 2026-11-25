import { useSnapshotQuery } from "../queries/index.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, type FormEvent, type ReactNode } from "react";
import { AuthActions } from "../components/app/auth-form.js";
import { AuthCard } from "../components/app/auth-layout.js";
import { FailureAlert, WarningAlert } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { FormField } from "../components/app/form-field.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { SummaryPanel, type SummaryRow } from "../components/app/summary-panel.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import type { Result } from "../contract/respond.js";
import { decideCliAuthorization, inspectCliAuthorization } from "./functions.js";

/**
 * What the reader is deciding about: the code to match against their terminal, who gets in, and
 * how long they have to decide. The code is the first fact because a prefilled link skips the
 * step where the reader typed it, so this is the only place they can check it.
 */
const CODE_LABEL = "Verification code";
const RECIPIENT_LABEL = "Organization receiving access";
const EXPIRY_LABEL = "Request expires";

export interface CliLoginSearch {
  code?: string;
}

/** The route owns `?code=`, so the server render and the first client render agree on it. */
export function parseCliLoginSearch(search: Record<string, unknown>): CliLoginSearch {
  const code = typeof search["code"] === "string" ? search["code"].trim() : "";
  return code === "" ? {} : { code };
}

export function CliLoginApproval({
  accountId,
  organizationId,
  code,
  onCode,
}: ApprovalIdentity & {
  code: string | undefined;
  /** The reader typed a code: the route puts it in the address, which brings it back here. */
  onCode: (code: string) => void;
}) {
  const queryClient = useQueryClient();
  const inspect = useServerFn(inspectCliAuthorization);
  const snapshot = useSnapshotQuery({
    queryKey: ["cli-authorization", accountId, organizationId, code],
    queryFn: () => inspect({ data: { userCode: code! } }),
    enabled: code !== undefined,
  });
  const decide = useMutation({
    mutationKey: ["cli-authorization-decision"],
    mutationFn: useServerFn(decideCliAuthorization) as (
      input: Parameters<typeof decideCliAuthorization>[0],
    ) => Promise<Result<{ decision: "approved" | "denied" }>>,
    onSuccess: async (result) => {
      if (result.status !== "ok" || result.data.decision !== "approved") return;
      // The terminal goes on to connect a daemon, so whatever counts daemons is already stale.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["daemons"] }),
        queryClient.invalidateQueries({ queryKey: ["home"] }),
      ]);
    },
  });
  const submitDecision = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (snapshot.status !== "success" || code === undefined) return;
      const submitter = "submitter" in event.nativeEvent ? event.nativeEvent.submitter : undefined;
      const decision =
        submitter instanceof HTMLButtonElement && submitter.value === "deny" ? "deny" : "approve";
      decide.mutate({
        data: {
          userCode: code,
          decision,
          organizationId: snapshot.data.organization.id,
        },
      });
    },
    [code, decide, snapshot.data, snapshot.status],
  );
  const resolved = snapshot.status === "success" ? snapshot.data : undefined;
  const organizationName = resolved?.organization.name;
  const expiresAt = resolved?.expiresAt;
  const facts = useMemo<SummaryRow[]>(
    () => [
      { label: CODE_LABEL, value: <span className="font-mono">{code}</span> },
      { label: RECIPIENT_LABEL, value: organizationName ?? <Skeleton className="h-5 w-40" /> },
      {
        label: EXPIRY_LABEL,
        value:
          expiresAt === undefined ? (
            <Skeleton className="h-5 w-24" />
          ) : (
            <RelativeTime value={expiresAt} />
          ),
      },
    ],
    [code, expiresAt, organizationName],
  );

  if (code !== undefined && snapshot.status === "pending") return <Loading rows={facts} />;
  if (snapshot.status === "error") {
    return (
      <Centered>
        <FailureAlert
          title="CLI login unavailable"
          error={snapshot.error}
          fallback="This CLI login request is unavailable or expired"
        />
      </Centered>
    );
  }
  if (decide.data?.status === "ok" && resolved !== undefined) {
    return (
      <Centered>
        <Decided
          decision={decide.data.data.decision}
          organizationSlug={resolved.organization.slug}
        />
      </Centered>
    );
  }
  if (code === undefined || snapshot.data === undefined) return <CodeEntry onCode={onCode} />;
  const request = snapshot.data;
  const failed = decide.isError || decide.data?.status === "error";
  return (
    <Centered>
      <AuthCard
        titleId="approval-heading"
        title="Approve CLI login"
        description="Grant this terminal durable access to one organization"
      >
        <SummaryPanel label="CLI login" rows={facts} />
        {request.canManage ? (
          <form className="grid gap-6" onSubmit={submitDecision} aria-label="Approve CLI login">
            <p className="text-sm text-muted-foreground">
              The credential can list projects, validate and install configuration, enroll daemons,
              and dispatch manual runs for this organization until revoked
            </p>
            {failed ? (
              <FailureAlert
                title="Decision not recorded"
                error={decide.data}
                fallback="Hub did not receive this CLI login decision. Check your connection and confirm the request is still active"
              />
            ) : null}
            <FormActions>
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
                Approve CLI login
              </Button>
            </FormActions>
          </form>
        ) : (
          <WarningAlert title="Approval required">
            Switch to an organization where you are an owner or admin, then reopen the login URL
          </WarningAlert>
        )}
      </AuthCard>
    </Centered>
  );
}

interface ApprovalIdentity {
  accountId: string;
  organizationId: string;
}

/**
 * The decision is recorded and the terminal has it. An approved login goes on to connect a daemon
 * from that terminal, so the way on is the list where it will show up.
 */
function Decided({
  decision,
  organizationSlug,
}: {
  decision: "approved" | "denied";
  organizationSlug: string;
}) {
  const daemonsParams = useMemo(() => ({ organizationSlug }), [organizationSlug]);
  if (decision === "denied") {
    return (
      <AuthCard
        titleId="approval-outcome-heading"
        title="CLI login denied"
        description="You can close this window and return to the terminal"
      >
        <p role="status">The terminal has received the decision</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      titleId="approval-outcome-heading"
      title="CLI login approved"
      description="Return to the terminal to finish"
    >
      <p role="status" className="sr-only">
        The terminal has received the decision
      </p>
      <AuthActions>
        <Button asChild size="lg" variant="outline">
          <Link to="/o/$organizationSlug/daemons" params={daemonsParams}>
            View daemons
          </Link>
        </Button>
      </AuthActions>
    </AuthCard>
  );
}

function CodeEntry({ onCode }: { onCode: (code: string) => void }) {
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const code = new FormData(event.currentTarget).get("code");
      if (typeof code !== "string" || code.trim() === "") return;
      onCode(code.trim());
    },
    [onCode],
  );
  return (
    <Centered>
      <AuthCard
        titleId="cli-login-code-heading"
        title="Log in the Paseo CLI"
        description="Enter the code shown in your terminal"
      >
        <form className="grid gap-6" onSubmit={submit} aria-label="Log in the Paseo CLI">
          <FormField
            kind="text"
            id="cli-login-code"
            name="code"
            label="Verification code"
            description="Only approve a code you requested yourself"
            autoComplete="one-time-code"
            required
          />
          <FormActions>
            <Button type="submit">Continue</Button>
          </FormActions>
        </form>
      </AuthCard>
    </Centered>
  );
}

/**
 * The approval card before the request is known. The card, its heading, and the label on the one
 * fact it is waiting for are already known, so only that fact and the decision buttons are
 * placeholders.
 */
function Loading({ rows }: { rows: readonly SummaryRow[] }) {
  return (
    <Centered>
      <div aria-busy="true">
        <AuthCard
          titleId="approval-loading-heading"
          title="Approve CLI login"
          description="Grant this terminal durable access to one organization"
        >
          <SummaryPanel label="CLI login" rows={rows} />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <FormActions>
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-40" />
          </FormActions>
        </AuthCard>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-lg">{children}</div>;
}
