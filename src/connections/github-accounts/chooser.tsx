/* oxlint-disable typescript-eslint/no-unsafe-type-assertion, eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- the return route is a server-chosen Hub path the generated route type cannot express, and each row's action and status are bound to that row's own account */
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AuthLayout } from "../../components/app/auth-layout.js";
import { Card, CardSkeleton } from "../../components/app/card.js";
import { FailureAlert } from "../../components/app/failure-alert.js";
import { PageHeader, PageHeaderSkeleton } from "../../components/app/page.js";
import { RecordList, RecordRow } from "../../components/app/record-list.js";
import { StatusPill } from "../../components/app/status-pill.js";
import { TwoLine } from "../../components/app/two-line.js";
import { Button } from "../../components/ui/button.js";
import type { Result } from "../../contract/respond.js";
import {
  addGitHubAccount,
  chooseGitHubAccount,
  type Destination,
  type GitHubAccountChoice,
  type GitHubAccountChooser,
} from "./functions.js";

const TITLE = "Choose a GitHub account";
const DESCRIPTION = "Connect an account that has the Hub app, or add the app to another account.";

/**
 * Where a GitHub connection lands when the App is already installed somewhere the person can see.
 * Framed like every surface outside the dashboard, because it can be reached before there is one.
 * Their one decision is which account; everything that cannot be connected says why in a line.
 */
export function GitHubAccountChooserPage({
  state,
  chooser,
}: {
  state: string;
  chooser: GitHubAccountChooser;
}) {
  const choose = useMutation({
    mutationFn: useServerFn(chooseGitHubAccount) as (
      input: Parameters<typeof chooseGitHubAccount>[0],
    ) => Promise<Result<Destination>>,
    onSuccess: follow,
  });
  const addAccount = useMutation({
    mutationFn: useServerFn(addGitHubAccount) as (
      input: Parameters<typeof addGitHubAccount>[0],
    ) => Promise<Result<Destination>>,
    onSuccess: follow,
  });
  const busy = choose.isPending || addAccount.isPending || leaving(choose, addAccount);
  const failed = [choose, addAccount].find(
    (mutation) => mutation.isError || mutation.data?.status === "error",
  );
  return (
    <AuthLayout width="lg">
      <PageHeader title={TITLE} description={DESCRIPTION}>
        <Button variant="ghost" asChild>
          <Link to={chooser.returnRoute as never}>Cancel</Link>
        </Button>
      </PageHeader>
      {failed === undefined ? null : (
        <FailureAlert
          standalone
          title="GitHub wasn't connected"
          error={failed.data ?? failed.error}
          fallback="Hub couldn't reach this GitHub connection. Connect GitHub again."
        />
      )}
      <Card
        title="GitHub accounts"
        description="Accounts where you can see the Hub app."
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => addAccount.mutate({ data: { state } })}
          >
            Add another account
          </Button>
        }
      >
        <RecordList label="GitHub accounts">
          {chooser.choices.map((choice) => (
            <RecordRow
              key={choice.installationId}
              status={
                choice.availability === "connected" ? (
                  <StatusPill tone="success">Connected</StatusPill>
                ) : undefined
              }
              actions={
                <ChoiceAction
                  choice={choice}
                  busy={busy}
                  onConnect={() =>
                    choose.mutate({ data: { state, installationId: choice.installationId } })
                  }
                />
              }
            >
              <TwoLine primary={choice.accountLogin} secondary={explanation(choice)} />
            </RecordRow>
          ))}
        </RecordList>
      </Card>
    </AuthLayout>
  );
}

export function GitHubAccountChooserSkeleton() {
  return (
    <AuthLayout width="lg">
      <PageHeaderSkeleton description={DESCRIPTION} />
      <CardSkeleton lines={2} />
    </AuthLayout>
  );
}

export function GitHubAccountChooserUnavailable({ error }: { error: Result<unknown> }) {
  return (
    <AuthLayout width="lg">
      <PageHeader title={TITLE} description={DESCRIPTION} />
      <FailureAlert
        title="GitHub accounts unavailable"
        error={error}
        fallback="Hub couldn't reach this GitHub connection. Connect GitHub again."
      />
    </AuthLayout>
  );
}

function ChoiceAction({
  choice,
  busy,
  onConnect,
}: {
  choice: GitHubAccountChoice;
  busy: boolean;
  onConnect: () => void;
}) {
  if (choice.availability !== "available") return null;
  return (
    <Button
      size="sm"
      disabled={busy}
      aria-label={`Connect ${choice.accountLogin}`}
      onClick={onConnect}
    >
      Connect
    </Button>
  );
}

/** One line per account: what connecting it means, or why it cannot be connected. */
function explanation(choice: GitHubAccountChoice): string {
  if (choice.availability === "available") {
    return choice.accountType === "User" ? "Personal account" : "Organization";
  }
  if (choice.availability === "connected") return "Already connected to this organization.";
  if (choice.availability === "connectedElsewhere") {
    return "Connected to another organization on this Hub. Disconnect it there to connect it here.";
  }
  return `Only an owner of ${choice.accountLogin} can connect it.`;
}

function follow(result: Result<Destination>): void {
  if (result.status === "ok") window.location.assign(result.data.url);
}

/** A step that succeeded is navigating away; the page stays disabled until it is gone. */
function leaving(...mutations: { data: Result<Destination> | undefined }[]): boolean {
  return mutations.some((mutation) => mutation.data?.status === "ok");
}
