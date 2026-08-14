/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- open/close handlers are bound per rendered provider section */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { completeAppSetup } from "../auth/functions.js";
import { useActiveAccount } from "../auth/active-account.js";
import { AuthLayout } from "../components/app/auth-layout.js";
import { PageHeader } from "../components/app/page.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import type { Result } from "../contract/respond.js";
import { PROVIDER_GUIDES } from "./guides.js";
import { providerApplicationsOverview } from "./functions.js";
import { ProviderSection, type SectionReturn } from "./provider-section.js";
import type { Provider, ProviderApplicationOverview, ProviderApplicationSurface } from "./index.js";

const OVERVIEW_KEY = ["provider-applications"] as const;

/**
 * One cached overview for the whole surface. The journey frame reads it to decide whether the
 * way out reads as finishing, and the sections read it for their own state; sharing the query
 * key means both see exactly the same answer.
 */
function useProviderApplicationsOverview() {
  const load = useServerFn(providerApplicationsOverview);
  return useQuery({ queryKey: OVERVIEW_KEY, queryFn: () => load() });
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
  initiallyOpen,
}: {
  surface: ProviderApplicationSurface;
  organizationId: string;
  /** Opened on arrival when nothing else claims it — one job on screen, not three. */
  initiallyOpen?: Provider;
}) {
  const [returned] = useState(readAppReturn);
  const [open, setOpen] = useState<Partial<Record<Provider, boolean>>>(() =>
    returned === undefined ? {} : { [returned.provider]: true },
  );
  const query = useProviderApplicationsOverview();
  const section = useRef<HTMLDivElement>(null);
  useEffect(stripAppReturn, []);
  useEffect(() => {
    if (returned !== undefined) section.current?.scrollIntoView({ block: "start" });
  }, [returned]);

  if (query.isPending) return <OverviewLoading />;
  if (query.isError || query.data.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {query.data?.status === "error"
            ? query.data.error.message
            : "We couldn't load your apps. Reload the page."}
        </AlertDescription>
      </Alert>
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
            open={
              open[guide.provider] ??
              (initiallyOpen === guide.provider &&
                overview.providers[guide.provider].status !== "connected" &&
                overview.providers[guide.provider].status !== "managedByEnvironment")
            }
            onOpenChange={(next) => setOpen((current) => ({ ...current, [guide.provider]: next }))}
            {...(returned?.provider === guide.provider
              ? { returned: returned.outcome }
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
        <div
          key={guide.provider}
          className="flex min-h-11 items-center gap-3 rounded-lg border bg-card px-4 py-3"
        >
          <span className="grid min-w-0 flex-1 gap-1">
            <span className="font-medium">{guide.name}</span>
            <span className="text-sm text-muted-foreground">{guide.summary}</span>
          </span>
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * First run. The operator has an account and an organization and nothing else; the dashboard
 * would introduce projects before there is any reason to explain them.
 */
export function AppSetupEntry({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const overview = useProviderApplicationsOverview();
  const connected = overview.data?.status === "ok" ? connectedProviderCount(overview.data.data) : 0;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const finish = useMutation({
    mutationFn: useServerFn(completeAppSetup) as (
      input: Parameters<typeof completeAppSetup>[0],
    ) => Promise<Result<Record<string, never>>>,
    onSuccess: async (response) => {
      if (response.status === "ok") await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const done = useCallback(() => finish.mutate({}), [finish]);
  return (
    <AuthLayout width="lg">
      <div className="grid min-w-0 gap-6">
        <div className="grid gap-1.5">
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-xl font-semibold tracking-tight outline-none"
          >
            Set up your apps
          </h1>
          <p className="text-sm text-balance text-muted-foreground">
            Paseo Hub talks to GitHub, Slack, and Discord through apps you create and own. Set up
            the ones you want to use.
          </p>
        </div>
        {finish.data?.status === "error" ? (
          <Alert variant="destructive">
            <AlertDescription>{finish.data.error.message}</AlertDescription>
          </Alert>
        ) : null}
        <ProviderApplications
          surface="appSetup"
          organizationId={organizationId}
          initiallyOpen="github"
        />
        <div className="sticky bottom-0 -mx-6 border-t bg-background px-6 py-4 sm:static sm:mx-0 sm:flex sm:justify-end sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
          <Button
            className="w-full sm:w-auto"
            variant={connected > 0 ? "default" : "ghost"}
            disabled={finish.isPending}
            onClick={done}
          >
            {connected > 0 ? "Finish" : "Do this later"}
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}

/** Instance → Apps. The same sections, later, with no journey wrapped around them. */
export function AppsPanel() {
  const account = useActiveAccount();
  return (
    <>
      <PageHeader title="Apps" description="The GitHub, Slack, and Discord apps this Hub uses." />
      <div className="max-w-3xl">
        <ProviderApplications surface="apps" organizationId={account.organization.id} />
      </div>
    </>
  );
}

interface AppReturn {
  provider: Provider;
  outcome: SectionReturn;
}

const RETURN_MESSAGES: Readonly<Record<string, SectionReturn>> = {
  github_connected: { tone: "success", message: "GitHub connected." },
  slack_connected: { tone: "success", message: "Slack connected." },
  discord_connected: { tone: "success", message: "Discord connected." },
  github_cancelled: { tone: "error", message: "You cancelled the GitHub installation." },
  slack_cancelled: { tone: "error", message: "You cancelled the Slack installation." },
  discord_cancelled: { tone: "error", message: "You cancelled the Discord installation." },
  github_approval_required: {
    tone: "error",
    message: "GitHub owner approval is required. Retry after approval.",
  },
  slack_bot_failed: {
    tone: "error",
    message:
      "Slack completed the installation, but the app couldn't act in your workspace. Nothing was saved.",
  },
  provider_not_configured: {
    tone: "error",
    message: "Set up the app before connecting it.",
  },
};

/**
 * Reads the outcome an install or authorization came back with. The identity itself is read from
 * the refreshed overview — the query only says which section to open and what happened.
 */
function readAppReturn(): AppReturn | undefined {
  if (typeof window === "undefined") return undefined;
  const url = new URL(window.location.href);
  const provider = url.searchParams.get("app");
  const result = url.searchParams.get("result");
  if (provider !== "github" && provider !== "slack" && provider !== "discord") return undefined;
  if (result === null) return undefined;
  return {
    provider,
    outcome: RETURN_MESSAGES[result] ?? {
      tone: "error",
      message: "The connection could not be completed.",
    },
  };
}

/** Clear callback state after the router commits, so its initial URL cannot restore the query. */
function stripAppReturn(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("app") && !url.searchParams.has("result")) return;
  url.searchParams.delete("app");
  url.searchParams.delete("result");
  window.history.replaceState(window.history.state, "", url);
}
