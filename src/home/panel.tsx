/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- one screen binds one snapshot; a row's action and status are that row's own slots */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express server-resolved organization URLs */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Cpu, History, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useActiveAccount } from "../auth/active-account.js";
import { CardSkeleton } from "../components/app/card.js";
import { CopyField } from "../components/app/copy-field.js";
import { Disclosure } from "../components/app/disclosure.js";
import { EmptyState } from "../components/app/empty-state.js";
import { WarningAlert } from "../components/app/failure-alert.js";
import { PageHeader, PageHeaderSkeleton } from "../components/app/page.js";
import { RecordList, RecordRow } from "../components/app/record-list.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StatGrid, StatTile } from "../components/app/stat-tile.js";
import { StatusPill, statusLabel, type StatusTone } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import { connectionStatus, type ConnectionStatus } from "../connections/functions.js";
import { CONNECTION_PROVIDERS } from "../connections/result-contract.js";
import { daemonLoginCommand, GRANT_EXECUTE_COMMAND } from "../daemons/handoff.js";
import { queryState } from "../projects/panel-state.js";
import { useRouteTenant } from "../projects/context.js";
import { deriveChecklist, type Checklist, type ChecklistStep } from "./checklist.js";
import { homeSnapshot, type HomeSnapshot } from "./functions.js";

const HOME_DESCRIPTION = "What to do next, and what has run.";
const RECENT_RUNS_SHOWN = 5;

export function HomePanel() {
  const tenant = useRouteTenant();
  const account = useActiveAccount();
  const scope = { organizationSlug: tenant.organization.slug };
  const load = useServerFn(homeSnapshot);
  const snapshot = useQuery({
    queryKey: ["home", tenant.account.id, tenant.organization.id],
    queryFn: () => load({ data: scope }),
  });
  const loadStatus = useServerFn(connectionStatus);
  const status = useQuery({
    queryKey: ["connection-status", tenant.account.id, tenant.organization.id],
    queryFn: () => loadStatus({ data: scope }),
  });
  const home = queryState<HomeSnapshot>(snapshot, "Overview unavailable", <HomeLoading />);
  if (!home.ok) return home.element;
  const apps = queryState<ConnectionStatus>(status, "Connections unavailable", <HomeLoading />);
  if (!apps.ok) return apps.element;
  const data = home.data;
  const base = `/o/${data.organization.slug}`;
  const checklist = deriveChecklist({
    appsConfigured: CONNECTION_PROVIDERS.some(
      (provider) => apps.data[provider].status !== "notConfigured",
    ),
    snapshot: data,
  });
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
      <Section title="Overview" description={`The last ${String(data.windowDays)} days.`}>
        <StatGrid>
          <StatTile
            label="Runs"
            icon={History}
            value={String(data.runs.length)}
            detail={runOutcomes(data.runs)}
          />
          <StatTile
            label="Daemons connected"
            icon={Cpu}
            value={String(data.daemons.filter(({ presence }) => presence === "connected").length)}
            detail={daemonDetail(data.daemons)}
          />
          <StatTile
            label="Agents used"
            icon={Sparkles}
            value={String(agentsUsed(data.runs).length)}
            detail={agentDetail(agentsUsed(data.runs))}
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
        {data.runs.length === 0 ? (
          <EmptyState
            title="No runs yet"
            description="Runs appear here as soon as a trigger launches an agent."
          />
        ) : (
          <RecordList label="Recent runs">
            {data.runs.slice(0, RECENT_RUNS_SHOWN).map((run) => (
              <RecordRow
                key={run.id}
                status={
                  <StatusPill tone={runTone(run.status)}>{statusLabel(run.status)}</StatusPill>
                }
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
        )}
      </Section>
      <Section
        title="Daemons"
        action={
          <Button variant="link" asChild>
            <Link to={`${base}/daemons` as never}>Manage</Link>
          </Button>
        }
      >
        {data.daemons.length === 0 ? (
          <EmptyState
            title="No daemons"
            description="Hub runs your triggers on machines you own. The checklist above has the command."
          />
        ) : (
          <RecordList label="Daemons">
            {data.daemons.map((daemon) => (
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
        )}
      </Section>
    </>
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
 * The four steps between an empty organization and its first run, each with the one thing to do
 * next. Open until the last step is done, collapsed after, and always the reader's to toggle;
 * nothing about it is stored, so revoking the daemon reopens it truthfully.
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
  const progress = `${String(checklist.completed)} of ${String(checklist.steps.length)} done`;
  return (
    <Section>
      <Disclosure
        id="get-started"
        open={open}
        onOpenChange={setOpen}
        title="Get started"
        description="Connect an app and a daemon, create a trigger, and run it."
        status={
          <StatusPill tone={checklist.complete ? "success" : "neutral"}>{progress}</StatusPill>
        }
      >
        <RecordList label="Get started">
          {checklist.steps.map((step) => (
            <StepRow key={step.key} {...stepPresentation(step, snapshot, base, operator)} />
          ))}
        </RecordList>
      </Disclosure>
    </Section>
  );
}

interface StepPresentation {
  title: string;
  hint: ReactNode;
  status: { label: string; tone: StatusTone };
  /** The one next action, when there is one the reader can press. */
  action?: ReactNode;
  /** A command to run somewhere else, when that is the next action. */
  command?: { label: string; value: string };
}

function StepRow({ title, hint, status, action, command }: StepPresentation) {
  return (
    <RecordRow
      status={<StatusPill tone={status.tone}>{status.label}</StatusPill>}
      {...(action === undefined ? {} : { actions: action })}
    >
      <div className="grid min-w-0 gap-2">
        <TwoLine primary={title} secondary={hint} />
        {command === undefined ? null : <CopyField label={command.label} value={command.value} />}
      </div>
    </RecordRow>
  );
}

const DONE = { label: "Done", tone: "success" } as const;
const TO_DO = { label: "To do", tone: "neutral" } as const;

function stepPresentation(
  step: ChecklistStep,
  snapshot: HomeSnapshot,
  base: string,
  operator: boolean,
): StepPresentation {
  if (step.key === "app") return appStep(step.state, snapshot, base, operator);
  if (step.key === "daemon") return daemonStep(step.state, snapshot);
  if (step.key === "trigger") return triggerStep(step.state, snapshot, base);
  return runStep(step.state, snapshot, base);
}

function appStep(
  state: Extract<ChecklistStep, { key: "app" }>["state"],
  snapshot: HomeSnapshot,
  base: string,
  operator: boolean,
): StepPresentation {
  const title = "Connect an app";
  if (state === "done") {
    return {
      title,
      hint: snapshot.connections.map(({ label }) => label).join(", "),
      status: DONE,
    };
  }
  if (state === "setup") {
    return {
      title,
      hint: operator
        ? "This Hub has no GitHub, Slack, or Discord app yet. Set one up first."
        : "This Hub has no GitHub, Slack, or Discord app yet. Ask whoever runs it to set one up.",
      status: { label: "Needs setup", tone: "warning" },
      ...(operator
        ? {
            action: (
              <Button asChild variant="outline" size="sm">
                <Link to={"/apps" as never}>Set up apps</Link>
              </Button>
            ),
          }
        : {}),
    };
  }
  return {
    title,
    hint: "GitHub, Slack, or Discord: the place events come from.",
    status: TO_DO,
    action: (
      <Button asChild variant="outline" size="sm">
        <Link to={`${base}/connections` as never}>Connect an app</Link>
      </Button>
    ),
  };
}

function daemonStep(
  state: Extract<ChecklistStep, { key: "daemon" }>["state"],
  snapshot: HomeSnapshot,
): StepPresentation {
  const title = "Connect a daemon";
  if (state === "done") {
    const able = snapshot.daemons.filter(({ canExecute }) => canExecute);
    const connected = able.filter(({ presence }) => presence === "connected").length;
    return {
      title,
      hint: `${able.map(({ slug }) => slug).join(", ")} · ${String(connected)} of ${String(able.length)} connected`,
      status: DONE,
    };
  }
  if (state === "cannotRun") {
    return {
      title,
      hint: `${snapshot.daemons.map(({ slug }) => slug).join(", ")} is connected but was not allowed to run Hub automations. Run this on it:`,
      status: { label: "Cannot run agents", tone: "warning" },
      command: { label: "Grant command", value: GRANT_EXECUTE_COMMAND },
    };
  }
  return {
    title,
    hint: "Hub runs your triggers on a machine you own. Run this where your code lives, and answer yes to running Hub automations:",
    status: TO_DO,
    command: { label: "Login command", value: daemonLoginCommand(window.location.origin) },
  };
}

function triggerStep(
  state: Extract<ChecklistStep, { key: "trigger" }>["state"],
  snapshot: HomeSnapshot,
  base: string,
): StepPresentation {
  const title = "Create a trigger";
  if (state === "done") {
    return {
      title,
      hint: snapshot.triggers.map(({ name }) => name).join(", "),
      status: DONE,
    };
  }
  return {
    title,
    hint: "Decide which event launches which agent, and where.",
    status: TO_DO,
    action: (
      <Button asChild variant="outline" size="sm">
        <Link to={`${base}/triggers/new` as never}>New trigger</Link>
      </Button>
    ),
  };
}

function runStep(
  state: Extract<ChecklistStep, { key: "run" }>["state"],
  snapshot: HomeSnapshot,
  base: string,
): StepPresentation {
  const title = "Run it";
  const latest = snapshot.runs[0];
  if (state === "done" && latest !== undefined) {
    return {
      title,
      hint: (
        <>
          {latest.triggerName} ran <RelativeTime value={latest.receivedAt} />
        </>
      ),
      status: DONE,
      action: (
        <Button asChild variant="outline" size="sm">
          <Link to={`${base}/activity` as never}>View activity</Link>
        </Button>
      ),
    };
  }
  return { title, hint: runHint(snapshot.triggers), status: TO_DO };
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
