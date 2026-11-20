/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- one screen binds one snapshot; a row's action and status are that row's own slots */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express server-resolved organization URLs */
import { useSnapshotQuery } from "../queries/index.js";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Cpu, History, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useActiveAccount } from "../auth/active-account.js";
import { CardSkeleton } from "../components/app/card.js";
import { CopyField } from "../components/app/copy-field.js";
import { Disclosure } from "../components/app/disclosure.js";
import { WarningAlert } from "../components/app/failure-alert.js";
import { PageHeader, PageHeaderSkeleton } from "../components/app/page.js";
import { ProgressSteps, type ProgressStep } from "../components/app/progress-steps.js";
import { RecordList, RecordRow } from "../components/app/record-list.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StatGrid, StatTile } from "../components/app/stat-tile.js";
import { StatusPill, statusLabel, type StatusTone } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import { daemonLoginCommand, GRANT_EXECUTE_COMMAND } from "../daemons/handoff.js";
import { queryState } from "../projects/panel-state.js";
import { useRouteTenant } from "../projects/context.js";
import { deriveChecklist, type Checklist, type ChecklistStep } from "./checklist.js";
import { homeSnapshot, type HomeSnapshot } from "./functions.js";

const HOME_DESCRIPTION = "What to do next, and what has run.";

export function HomePanel() {
  const tenant = useRouteTenant();
  const account = useActiveAccount();
  const scope = { organizationSlug: tenant.organization.slug };
  const load = useServerFn(homeSnapshot);
  const snapshot = useSnapshotQuery({
    queryKey: ["home", tenant.account.id, tenant.organization.id],
    queryFn: () => load({ data: scope }),
  });
  const home = queryState<HomeSnapshot>(snapshot, "Overview unavailable", <HomeLoading />);
  if (!home.ok) return home.element;
  const data = home.data;
  const base = `/o/${data.organization.slug}`;
  const checklist = deriveChecklist(data);
  const unroutedCount = data.unrouted.reduce((total, { count }) => total + count, 0);
  return (
    <>
      <PageHeader title="Home" description={HOME_DESCRIPTION} />
      {/* Completing the last step is what collapses the list: the key remounts it with the
          collapsed default, and every toggle before or after that is the reader's own. */}
      <GetStarted
        key={checklist.complete ? "complete" : "incomplete"}
        checklist={checklist}
        snapshot={data}
        base={base}
        operator={account.isInstanceOperator}
      />
      {unroutedCount === 0 ? null : (
        <WarningAlert
          standalone
          title="Events are arriving with no trigger listening"
          action={
            <Button asChild variant="outline" size="sm">
              <Link to={`${base}/triggers/new` as never}>Create a trigger</Link>
            </Button>
          }
        >
          <p>{unroutedSentence(data.unrouted, data.windowDays)}</p>
        </WarningAlert>
      )}
      {/* Get started is the empty state for everything below: a section shows once it has
          records, so a new organization reads one list instead of zeros and "nothing yet". */}
      {data.recentRuns.length === 0 ? null : (
        <Runs
          runs={data.runs}
          recentRuns={data.recentRuns}
          daemons={data.daemons}
          windowDays={data.windowDays}
          base={base}
        />
      )}
      {data.daemons.length === 0 ? null : <Daemons daemons={data.daemons} base={base} />}
    </>
  );
}

function Runs({
  runs,
  recentRuns,
  daemons,
  windowDays,
  base,
}: {
  runs: HomeSnapshot["runs"];
  recentRuns: HomeSnapshot["recentRuns"];
  daemons: HomeSnapshot["daemons"];
  windowDays: number;
  base: string;
}) {
  const agents = agentsUsed(runs);
  return (
    <>
      <Section title="Overview" description={`The last ${String(windowDays)} days.`}>
        <StatGrid>
          <StatTile
            label="Runs"
            icon={History}
            value={String(runs.length)}
            detail={runOutcomes(runs)}
          />
          <StatTile
            label="Daemons connected"
            icon={Cpu}
            value={String(daemons.filter(({ presence }) => presence === "connected").length)}
            detail={daemonDetail(daemons)}
          />
          <StatTile
            label="Agents used"
            icon={Sparkles}
            value={String(agents.length)}
            detail={agentDetail(agents)}
          />
        </StatGrid>
      </Section>
      <Section
        title="Recent runs"
        action={
          <Button variant="link" asChild>
            <Link to={`${base}/activity` as never}>View all</Link>
          </Button>
        }
      >
        <RecordList label="Recent runs">
          {recentRuns.map((run) => (
            <RecordRow
              key={run.id}
              status={<StatusPill tone={runTone(run.status)}>{statusLabel(run.status)}</StatusPill>}
            >
              <TwoLine
                primary={run.triggerName}
                secondary={
                  <>
                    {run.source} · <RelativeTime value={run.receivedAt} />
                  </>
                }
              />
            </RecordRow>
          ))}
        </RecordList>
      </Section>
    </>
  );
}

function Daemons({ daemons, base }: { daemons: HomeSnapshot["daemons"]; base: string }) {
  return (
    <Section
      title="Daemons"
      action={
        <Button variant="link" asChild>
          <Link to={`${base}/daemons` as never}>Manage</Link>
        </Button>
      }
    >
      <RecordList label="Daemons">
        {daemons.map((daemon) => (
          <RecordRow
            key={daemon.id}
            status={
              <StatusPill tone={daemon.presence === "connected" ? "success" : "neutral"}>
                {daemon.presence === "connected" ? "Connected" : "Offline"}
              </StatusPill>
            }
          >
            <TwoLine
              primary={daemon.slug}
              secondary={daemon.canExecute ? "Hub automations" : "Connected only"}
            />
          </RecordRow>
        ))}
      </RecordList>
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
          hint: "Set up GitHub, Slack, Discord, or Linear on this Hub first.",
          action: stepAction("/apps", "Set up apps"),
        }
      : {
          ...step,
          state: "blocked",
          hint: "Ask whoever runs this Hub to set up GitHub, Slack, Discord, or Linear.",
        };
  }
  return {
    ...step,
    state: "todo",
    hint: "Pick where events come from: GitHub, Slack, Discord, or Linear.",
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
    hint: "Run this where your code lives, and allow Hub automations when asked.",
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
    hint: "Choose which event starts which agent.",
    action: stepAction(`${base}/triggers/new`, "New trigger"),
  };
}

function runStep(
  state: Extract<ChecklistStep, { key: "run" }>["state"],
  snapshot: HomeSnapshot,
): ProgressStep {
  const step = { key: "run", title: "Run it" };
  const latest = snapshot.recentRuns[0];
  if (state === "done" && latest !== undefined) {
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
  if (triggers.length === 0) return "Once a trigger exists, fire its event.";
  const hints = new Set<string>();
  for (const { event } of triggers) {
    const provider = event.split(".")[0];
    if (provider === "slack" || provider === "discord") {
      hints.add("Mention the bot in a channel it can see.");
    } else if (provider === "github") {
      hints.add("Open or comment on an issue or pull request in a connected repository.");
    } else if (provider === "linear") {
      hints.add("Update an issue in the connected Linear workspace.");
    } else if (provider === "schedule") {
      hints.add("It runs on its schedule.");
    } else if (provider === "webhook") {
      hints.add("Send a POST to the webhook URL with the secret from the trigger editor.");
    } else {
      hints.add("Dispatch it with an API key: POST /api/v1/manual-runs.");
    }
  }
  return [...hints].join(" ");
}

function unroutedSentence(unrouted: HomeSnapshot["unrouted"], windowDays: number): string {
  const total = unrouted.reduce((sum, { count }) => sum + count, 0);
  const sources = unrouted
    .map(({ provider, count }) => `${String(count)} from ${providerName(provider)}`)
    .join(", ");
  return `${String(total)} ${total === 1 ? "event" : "events"} in the last ${String(windowDays)} days were dropped because no trigger handles them: ${sources}.`;
}

function providerName(provider: HomeSnapshot["unrouted"][number]["provider"]): string {
  if (provider === "github") return "GitHub";
  if (provider === "slack") return "Slack";
  if (provider === "discord") return "Discord";
  if (provider === "linear") return "Linear";
  return statusLabel(provider);
}

function runOutcomes(runs: HomeSnapshot["runs"]): string {
  const succeeded = runs.filter(({ status }) => status === "succeeded").length;
  const failed = runs.filter(
    ({ status }) => status === "failed" || status === "timed_out" || status === "rejected",
  ).length;
  return `${String(succeeded)} succeeded · ${String(failed)} failed`;
}

function runTone(status: HomeSnapshot["runs"][number]["status"]): StatusTone {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out" || status === "rejected") return "danger";
  return "neutral";
}

function daemonDetail(daemons: HomeSnapshot["daemons"]): string {
  const cannot = daemons.filter(({ canExecute }) => !canExecute).length;
  return `${String(daemons.length)} enrolled${cannot === 0 ? "" : ` · ${String(cannot)} cannot run agents`}`;
}

function agentsUsed(runs: HomeSnapshot["runs"]): string[] {
  return [
    ...new Set(
      runs.flatMap(({ agent }) =>
        agent === null
          ? []
          : [agent.model === null ? agent.provider : `${agent.provider}/${agent.model}`],
      ),
    ),
  ];
}

function agentDetail(agents: readonly string[]): string {
  if (agents.length === 0) return "None yet";
  const shown = agents.slice(0, 3).join(", ");
  return agents.length > 3 ? `${shown} and ${String(agents.length - 3)} more` : shown;
}
