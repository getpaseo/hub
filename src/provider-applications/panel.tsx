/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- open/close handlers are bound per rendered provider section */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { completeAppSetup } from "../auth/functions.js";
import { useActiveAccount } from "../auth/active-account.js";
import { AuthLayout } from "../components/app/auth-layout.js";
import { FailureAlert, type Failure } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { PageHeader } from "../components/app/page.js";
import { Button } from "../components/ui/button.js";
import type { Result } from "../contract/respond.js";
import { connectionReturnCopy } from "../connections/result-contract.js";
import { useConnectionReturn } from "../connections/result.js";
import { PROVIDER_GUIDES } from "./guides.js";
import { providerApplicationsOverview } from "./functions.js";
import { ProviderSection, ProviderSectionLoading } from "./provider-section.js";
import type { Provider, ProviderApplicationOverview, ProviderApplicationSurface } from "./index.js";

const OVERVIEW_KEY = ["provider-applications"] as const;

/**
 * One cached overview for the whole surface. The journey frame reads it to decide whether the
 * way out reads as finishing, and the sections read it for their own state; sharing the query
 * key means both see exactly the same answer.
 */
function useProviderApplicationsOverview() {
  const load = useServerFn(providerApplicationsOverview);
  return useQuery({ queryKey: OVERVIEW_KEY, queryFn: () => load(), refetchInterval: 1_000 });
}

function connectedProviderCount(overview: ProviderApplicationOverview): number {
  return Object.values(overview.providers).filter((view) => view.connections.length > 0).length;
}

/**
 * The app setup surface. One component, two frames: the first-run journey renders it full
 * screen so nothing about the dashboard appears before the operator has a reason to see it,
 * and Instance → Apps renders the identical sections inside the shell.
 */
function ProviderApplications({
  surface,
  organizationId,
}: {
  surface: ProviderApplicationSurface;
  organizationId: string;
}) {
  const [returned] = useConnectionReturn();
  const [open, setOpen] = useState<Partial<Record<Provider, boolean>>>(() =>
    returned === undefined ? {} : { [returned.provider]: true },
  );
  const query = useProviderApplicationsOverview();
  const section = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (returned !== undefined) section.current?.scrollIntoView({ block: "start" });
  }, [returned]);

  if (query.isPending) return <OverviewLoading />;
  if (query.isError || query.data.status === "error") {
    return (
      <FailureAlert
        title="Your apps couldn't be loaded"
        error={query.data}
        fallback="Hub did not answer. Check your connection, then reload the page."
      />
    );
  }
  const overview = query.data.data;
  return (
    <div className="grid min-w-0 gap-3">
      {PROVIDER_GUIDES.map((guide) => (
        <div
          key={guide.provider}
          className="min-w-0"
          {...(returned?.provider === guide.provider ? { ref: section } : {})}
        >
          <ProviderSection
            guide={guide}
            view={overview.providers[guide.provider]}
            callbackOrigin={overview.callbackOrigin}
            surface={surface}
            organizationId={organizationId}
            // Closed until the operator picks one, or until a provider's own return has
            // something to show them. Three open manuals is not a choice, it is a wall.
            open={open[guide.provider] ?? false}
            onOpenChange={(next) => setOpen((current) => ({ ...current, [guide.provider]: next }))}
            {...(returned?.provider === guide.provider
              ? { returned: connectionReturnCopy(returned) }
              : { returned: undefined })}
          />
        </div>
      ))}
    </div>
  );
}

function OverviewLoading() {
  return (
    <div aria-label="Loading your apps" aria-busy="true" className="grid gap-3">
      {PROVIDER_GUIDES.map((guide) => (
        <ProviderSectionLoading key={guide.provider} guide={guide} open={false} />
      ))}
    </div>
  );
}

/**
 * First run. The operator has an account and an organization and nothing else; the dashboard
 * would introduce projects before there is any reason to explain them.
 *
 * Leaving is a server fact — app onboarding is complete the moment the request succeeds, so a CLI
 * authorization opened in another tab is no longer sent back here. Where the operator goes next
 * is the journey's decision, not this surface's: `onLeft` is called once the server agrees.
 */
export function AppSetupEntry({
  organizationId,
  onLeft,
}: {
  organizationId: string;
  onLeft: () => void;
}) {
  const queryClient = useQueryClient();
  const overview = useProviderApplicationsOverview();
  const connected = overview.data?.status === "ok" ? connectedProviderCount(overview.data.data) : 0;
  const finish = useMutation({
    mutationFn: useServerFn(completeAppSetup) as (
      input: Parameters<typeof completeAppSetup>[0],
    ) => Promise<Result<Record<string, never>>>,
    onSuccess: async (response) => {
      if (response.status !== "ok") return;
      await queryClient.invalidateQueries({ queryKey: ["account"] });
      onLeft();
    },
  });
  const done = useCallback(() => finish.mutate({}), [finish]);
  const failed = finish.data?.status === "error" || finish.isError;
  return (
    <AuthLayout width="xl">
      <PageHeader
        title="Set up your apps"
        description="Paseo Hub talks to GitHub, Slack, Discord, and Linear through apps you create and own. Set up the ones you want to use."
        focusOnMount
      />
      <div className="grid min-w-0 gap-6">
        {failed ? <ExitFailure error={finish.data} onRetry={done} /> : null}
        <ProviderApplications surface="appSetup" organizationId={organizationId} />
        <FormActions pinned>
          <Button
            variant={connected > 0 ? "default" : "ghost"}
            disabled={finish.isPending}
            onClick={done}
          >
            {connected > 0 ? "Finish" : "Do this later"}
          </Button>
        </FormActions>
      </div>
    </AuthLayout>
  );
}

/**
 * Why leaving app setup did not work.
 *
 * A rejected request and a request that never arrived are different failures with the same
 * consequence: the operator is still here and nothing has changed. The server owns the first and
 * says so itself; the second never reached a server, so the fallback sentence is the only thing
 * this page can offer, and it does rather than swallowing the press.
 *
 * The operator pressed a button and stayed where they were, so the alert takes the keyboard.
 */
function ExitFailure({ error, onRetry }: { error: Failure; onRetry: () => void }) {
  return (
    <FailureAlert
      title="Hub couldn't leave app setup"
      error={error}
      fallback="Hub didn't get the request, so nothing changed. Check your connection, then try again."
      onRetry={onRetry}
      focusOnArrival
    />
  );
}

/** Instance → Apps. The same sections, later, with no journey wrapped around them. */
export function AppsPanel() {
  const account = useActiveAccount();
  return (
    <>
      <PageHeader
        title="Apps"
        description="The GitHub, Slack, Discord, and Linear apps Hub uses to reach your workspaces."
      />
      <ProviderApplications surface="apps" organizationId={account.organization.id} />
    </>
  );
}
