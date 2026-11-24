/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- one screen binds one snapshot; a row's action and status are that row's own slots */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express server-resolved organization URLs */
import { useSnapshotQuery } from "../queries/index.js";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Cpu, History, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";

import { RANGE_LABELS } from "../activity/presentation.js";
import { activityLink, FAILED_RUN_STATUSES } from "../activity/query-contract.js";
import { useActiveAccount } from "../auth/active-account.js";
import { Card, CardSkeleton } from "../components/app/card.js";
import { CopyField } from "../components/app/copy-field.js";
import { DataCell, DataRow, DataTable, type DataColumn } from "../components/app/data-table.js";
import { Disclosure } from "../components/app/disclosure.js";
import { WarningAlert } from "../components/app/failure-alert.js";
import { PageHeader, PageHeaderSkeleton } from "../components/app/page.js";
import { ProgressSteps, type ProgressStep } from "../components/app/progress-steps.js";
import { RecordList, RecordRow } from "../components/app/record-list.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { SegmentedControl } from "../components/app/segmented-control.js";
import { StatGrid, StatTile } from "../components/app/stat-tile.js";
import { StatusPill } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import { daemonLoginCommand, GRANT_EXECUTE_COMMAND } from "../daemons/handoff.js";
import { queryState } from "../projects/panel-state.js";
import { useRouteTenant } from "../projects/context.js";
import { deriveChecklist, type Checklist, type ChecklistStep } from "./checklist.js";
import { homeSnapshot, type HomeSnapshot } from "./functions.js";
import { HOME_RANGES, homeRange, isHomeRange, type HomeRange } from "./range.js";

const HOME_DESCRIPTION = "Runs and daemon health across this organization";
const ROUTE = "/_shell/o/$organizationSlug/home";
const PATH = "/o/$organizationSlug/home";

const RANGE_OPTIONS = HOME_RANGES.map((range) => ({ value: range, label: range }));

const TRIGGER_COLUMNS: readonly DataColumn[] = [
  { header: "Trigger", fill: true },
  { header: "Runs", align: "end" },
  { header: "Failed", align: "end" },
  { header: "Last run", align: "end", className: "hidden sm:table-cell" },
];

export function HomePanel() {
  const tenant = useRouteTenant();
  const account = useActiveAccount();
  const range = homeRange(useSearch({ from: ROUTE }));
  const navigate = useNavigate({ from: PATH });
  const load = useServerFn(homeSnapshot);
  const snapshot = useSnapshotQuery({
    queryKey: ["home", tenant.account.id, tenant.organization.id, range],
    queryFn: () => load({ data: { organizationSlug: tenant.organization.slug, range } }),
    keepPrevious: true,
  });
  const home = queryState<HomeSnapshot>(snapshot, "Overview unavailable", <HomeLoading />);
  if (!home.ok) return home.element;
  const data = home.data;
  const base = `/o/${data.organization.slug}`;
  const checklist = deriveChecklist(data);
  const hasRun = data.latestRun !== null;
  return (
    <>
      <PageHeader title="Home" description={HOME_DESCRIPTION}>
        {hasRun ? (
          <SegmentedControl
            label="Range"
            value={range}
            options={RANGE_OPTIONS}
            onChange={(value) => {
              if (!isHomeRange(value)) return;
              void navigate({ search: value === "7d" ? {} : { range: value } });
            }}
          />
        ) : null}
      </PageHeader>
      <SuspendedConnections connections={data.connections} base={base} />
      {/* Completing the last step is what collapses the list: the key remounts it with the
          collapsed default, and every toggle before or after that is the reader's own. */}
      <GetStarted
        key={checklist.complete ? "complete" : "incomplete"}
        checklist={checklist}
        snapshot={data}
        base={base}
        operator={account.isInstanceOperator}
      />
      {/* Get started is the empty state for everything below: the overview shows once there is
          a run to count, so a new organization reads one list instead of zeros. */}
      {hasRun ? (
        <>
          <Figures snapshot={data} />
          <Triggers snapshot={data} />
        </>
      ) : null}
      {data.daemons.length === 0 ? null : (
        <Daemons daemons={data.daemons} range={data.range} slug={data.organization.slug} />
      )}
    </>
  );
}

/**
 * The one fault Home raises: a provider stopped delivering events, so triggers on it start
 * nothing until someone acts on the provider's side. Events no trigger listens to are not a
 * fault, so they are a quiet link under Triggers instead.
 */
function SuspendedConnections({
  connections,
  base,
}: {
  connections: HomeSnapshot["connections"];
  base: string;
}) {
  const suspended = connections.filter((connection) => connection.suspended);
  if (suspended.length === 0) return null;
  return (
    <WarningAlert
      standalone
      title="GitHub stopped sending events"
      action={
        <Button asChild variant="outline" size="sm">
          <Link to={`${base}/integrations` as never}>Open integrations</Link>
        </Button>
      }
    >
      <p>
        {suspended.map(({ label }) => label).join(", ")} is suspended on GitHub. Its triggers start
        nothing until it is unsuspended
      </p>
    </WarningAlert>
  );
}

function Figures({ snapshot }: { snapshot: HomeSnapshot }) {
  const slug = snapshot.organization.slug;
  const { runs, range, daemons } = snapshot;
  const total = runs.running + runs.succeeded + runs.failed + runs.timed_out + runs.rejected;
  const failed = runs.failed + runs.timed_out + runs.rejected;
  const online = daemons.filter(({ presence }) => presence === "connected").length;
  return (
    <Section>
      <StatGrid>
        <StatTile
          label="Runs"
          icon={History}
          value={count(total)}
          detail={`${count(runs.succeeded)} succeeded · ${count(runs.running)} running`}
          link={activityLink(slug, { range })}
        />
        <StatTile
          label="Failed"
          icon={TriangleAlert}
          value={count(failed)}
          detail={
            total === 0
              ? "No runs"
              : `${failureRate(failed, total)} failure rate · ${count(runs.timed_out)} timed out`
          }
          link={activityLink(slug, { range, status: FAILED_RUN_STATUSES.join(",") })}
        />
        <StatTile
          label="Daemons"
          icon={Cpu}
          value={`${count(online)} of ${count(daemons.length)}`}
          detail={daemonDetail(daemons, online)}
          link={{ to: `/o/${slug}/daemons` }}
        />
      </StatGrid>
    </Section>
  );
}

/** The triggers that ran most in the range. A row opens Activity on that trigger's runs. */
function Triggers({ snapshot }: { snapshot: HomeSnapshot }) {
  const navigate = useNavigate();
  const slug = snapshot.organization.slug;
  const range = snapshot.range;
  return (
    <Section
      title="Triggers"
      description={`Most runs in the ${RANGE_LABELS[range].toLowerCase()}`}
      action={
        <Button variant="link" asChild>
          <Link to={`/o/${slug}/triggers` as never}>All triggers</Link>
        </Button>
      }
    >
      <DataTable
        label="Triggers"
        columns={TRIGGER_COLUMNS}
        isEmpty={snapshot.busiestTriggers.length === 0}
        empty={{
          title: "No triggers",
          description: "Create a trigger to choose which event starts which agent",
        }}
        footer={{
          note: "Events that started no run",
          action: <UnmatchedEventsLink link={activityLink(slug, { view: "unmatched", range })} />,
        }}
      >
        {snapshot.busiestTriggers.map((trigger) => {
          const link = activityLink(slug, { range, trigger: trigger.id });
          return (
            <DataRow
              key={trigger.id}
              onSelect={() => {
                void navigate({ to: link.to as never, search: link.search as never });
              }}
            >
              <DataCell>
                <TwoLine
                  media={<ProviderGlyph provider={trigger.provider} />}
                  primary={
                    <Link
                      to={link.to as never}
                      search={link.search as never}
                      className="hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {trigger.name}
                    </Link>
                  }
                  secondary={trigger.event}
                />
              </DataCell>
              <DataCell>{count(trigger.runs)}</DataCell>
              <DataCell muted={trigger.failed === 0}>{count(trigger.failed)}</DataCell>
              <DataCell muted>
                {trigger.lastRunAt === null ? "Never" : <RelativeTime value={trigger.lastRunAt} />}
              </DataCell>
            </DataRow>
          );
        })}
      </DataTable>
    </Section>
  );
}

function UnmatchedEventsLink({ link }: { link: ReturnType<typeof activityLink> }) {
  return (
    <Button variant="link" size="sm" asChild>
      <Link to={link.to as never} search={link.search as never}>
        Unmatched events
      </Link>
    </Button>
  );
}

function Daemons({
  daemons,
  range,
  slug,
}: {
  daemons: HomeSnapshot["daemons"];
  range: HomeRange;
  slug: string;
}) {
  return (
    <Section
      title="Daemons"
      action={
        <Button variant="link" asChild>
          <Link to={`/o/${slug}/daemons` as never}>Manage</Link>
        </Button>
      }
    >
      <Card>
        <RecordList label="Daemons">
          {daemons.map((daemon) => {
            const link = activityLink(slug, { range, daemon: daemon.id });
            return (
              <RecordRow
                key={daemon.id}
                status={
                  <StatusPill tone={daemon.presence === "connected" ? "success" : "neutral"}>
                    {daemon.presence === "connected" ? "Connected" : "Offline"}
                  </StatusPill>
                }
                actions={
                  <Button variant="ghost" size="sm" asChild>
                    <Link
                      to={link.to as never}
                      search={link.search as never}
                      aria-label={`View runs on ${daemon.slug}`}
                    >
                      View runs
                    </Link>
                  </Button>
                }
              >
                <TwoLine
                  primary={daemon.slug}
                  secondary={`${daemon.canExecute ? "Hub automations" : "Connected only"} · ${runsIn(daemon.runs, range)}`}
                />
              </RecordRow>
            );
          })}
        </RecordList>
      </Card>
    </Section>
  );
}

function HomeLoading() {
  return (
    <div aria-busy="true" aria-label="Loading overview">
      <PageHeaderSkeleton description={HOME_DESCRIPTION} />
      <div className="grid gap-6">
        <CardSkeleton lines={4} />
        <CardSkeleton lines={2} />
      </div>
    </div>
  );
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** `4.2%`: one decimal, so a handful of failures among thousands still reads as more than none. */
function failureRate(failed: number, total: number): string {
  if (failed === 0) return "0%";
  return `${((failed / total) * 100).toFixed(1)}%`;
}

function runsIn(runs: number, range: HomeRange): string {
  return `${count(runs)} ${runs === 1 ? "run" : "runs"} in the ${RANGE_LABELS[range].toLowerCase()}`;
}

function daemonDetail(daemons: HomeSnapshot["daemons"], online: number): string {
  const offline = daemons.length - online;
  const cannot = daemons.filter(({ canExecute }) => !canExecute).length;
  const health = `${count(online)} online · ${count(offline)} offline`;
  return cannot === 0 ? health : `${health} · ${count(cannot)} cannot run agents`;
}

/**
 * The four steps between an empty organization and its first run, one open at a time. Open until
 * the last step is done, collapsed after, and always the reader's to toggle; nothing about it is
 * stored, so revoking the daemon reopens it truthfully.
 */
function GetStarted({
  checklist,
  snapshot,
  base,
  operator,
}: {
  checklist: Checklist;
  snapshot: HomeSnapshot;
  base: string;
  operator: boolean;
}) {
  const [open, setOpen] = useState(!checklist.complete);
  // The address the reader reached this Hub at is the address their daemon has to be told. Home
  // is a route, so it can be rendered on the server, where there is no window: the command is
  // simply absent from that render and arrives with the client.
  const origin = typeof window === "undefined" ? undefined : window.location.origin;
  const context = { base, operator, origin };
  return (
    <Section>
      <Disclosure
        id="get-started"
        open={open}
        onOpenChange={setOpen}
        title="Get started"
        status={`${String(checklist.completed)} of ${String(checklist.steps.length)}`}
      >
        <ProgressSteps
          label="Get started"
          steps={checklist.steps.map((step) => stepPresentation(step, snapshot, context))}
        />
      </Disclosure>
    </Section>
  );
}

/** What the page knows that the snapshot does not: where it is, who is reading, and from where. */
interface StepContext {
  base: string;
  operator: boolean;
  /** This Hub's address as the browser sees it; absent in a server render. */
  origin: string | undefined;
}

function stepPresentation(
  step: ChecklistStep,
  snapshot: HomeSnapshot,
  context: StepContext,
): ProgressStep {
  if (step.key === "app") return integrationStep(step.state, snapshot, context);
  if (step.key === "daemon") return daemonStep(step.state, snapshot, context.origin);
  if (step.key === "trigger") return triggerStep(step.state, snapshot, context.base);
  return runStep(step.state, snapshot);
}

function stepAction(to: string, label: string): ReactNode {
  return (
    <Button asChild size="sm">
      <Link to={to as never}>{label}</Link>
    </Button>
  );
}

function integrationStep(
  state: Extract<ChecklistStep, { key: "app" }>["state"],
  snapshot: HomeSnapshot,
  { base, operator }: StepContext,
): ProgressStep {
  const step = { key: "app", title: "Connect an integration" };
  if (state === "done") {
    return {
      ...step,
      state: "done",
      result: snapshot.connections.map(({ label }) => label).join(", "),
    };
  }
  if (state === "setup") {
    return operator
      ? {
          ...step,
          state: "blocked",
          hint: "Set up GitHub, Slack, Discord, or Linear on this Hub first",
          action: stepAction("/apps", "Set up apps"),
        }
      : {
          ...step,
          state: "blocked",
          hint: "Ask whoever runs this Hub to set up GitHub, Slack, Discord, or Linear",
        };
  }
  return {
    ...step,
    state: "todo",
    hint: "Pick where events come from: GitHub, Slack, Discord, or Linear",
    action: stepAction(`${base}/integrations`, "Connect integration"),
  };
}

function daemonStep(
  state: Extract<ChecklistStep, { key: "daemon" }>["state"],
  snapshot: HomeSnapshot,
  origin: string | undefined,
): ProgressStep {
  const step = { key: "daemon", title: "Connect a daemon" };
  if (state === "done") {
    return {
      ...step,
      state: "done",
      result: snapshot.daemons
        .filter(({ canExecute }) => canExecute)
        .map(({ slug }) => slug)
        .join(", "),
    };
  }
  if (state === "cannotRun") {
    const daemons = snapshot.daemons.map(({ slug }) => slug).join(", ");
    return {
      ...step,
      state: "blocked",
      hint: `${daemons} cannot run agents yet. Run this on it:`,
      action: <CopyField label="Grant command" value={GRANT_EXECUTE_COMMAND} labelHidden />,
    };
  }
  return {
    ...step,
    state: "todo",
    hint: "Run this where your code lives and allow Hub automations when asked",
    ...(origin === undefined
      ? {}
      : {
          action: (
            <CopyField label="Login command" value={daemonLoginCommand(origin)} labelHidden />
          ),
        }),
  };
}

function triggerStep(
  state: Extract<ChecklistStep, { key: "trigger" }>["state"],
  snapshot: HomeSnapshot,
  base: string,
): ProgressStep {
  const step = { key: "trigger", title: "Create a trigger" };
  if (state === "done") {
    return { ...step, state: "done", result: snapshot.triggers.map(({ name }) => name).join(", ") };
  }
  return {
    ...step,
    state: "todo",
    hint: "Choose which event starts which agent",
    action: stepAction(`${base}/triggers/new`, "New trigger"),
  };
}

function runStep(
  state: Extract<ChecklistStep, { key: "run" }>["state"],
  snapshot: HomeSnapshot,
): ProgressStep {
  const step = { key: "run", title: "Run it" };
  const latest = snapshot.latestRun;
  if (state === "done" && latest !== null) {
    return {
      ...step,
      state: "done",
      result: (
        <>
          {latest.triggerName} ran <RelativeTime value={latest.receivedAt} />
        </>
      ),
    };
  }
  return { ...step, state: "todo", hint: runHint(snapshot.triggers) };
}

/** How to make a trigger fire, said for the events the organization actually listens to. */
function runHint(triggers: HomeSnapshot["triggers"]): string {
  const events = triggers.filter(({ enabled }) => enabled).flatMap((trigger) => trigger.events);
  if (events.length === 0) return "Enable a trigger and fire one of its events";
  const hints = new Set<string>();
  for (const event of events) {
    const provider = event.split(".")[0];
    if (provider === "slack" || provider === "discord") {
      hints.add("Mention the bot in a channel it can see");
    } else if (provider === "github") {
      hints.add("Open or comment on an issue or pull request in a connected repository");
    } else if (provider === "linear") {
      hints.add("Update an issue in the connected Linear workspace");
    } else if (provider === "schedule") {
      hints.add("Runs on its schedule");
    } else if (provider === "webhook") {
      hints.add("Send a POST to the webhook URL with the secret from the trigger editor");
    } else {
      hints.add("Dispatch it with an API key: POST /api/v1/manual-runs");
    }
  }
  return [...hints].join(" · ");
}
