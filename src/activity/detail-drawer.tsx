/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- the drawer binds one record; its actions, status, and step pills are that record's own slots */
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Card, CardSkeleton } from "../components/app/card.js";
import { CodeBlock, CopyPageLink } from "../components/app/copy-field.js";
import { DetailSheet } from "../components/app/detail-sheet.js";
import { Disclosure } from "../components/app/disclosure.js";
import { EmptyState } from "../components/app/empty-state.js";
import { FailureAlert, NoticeAlert } from "../components/app/failure-alert.js";
import { RecordList, RecordRow } from "../components/app/record-list.js";
import { formatAbsolute } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { SummaryPanel, type SummaryRow } from "../components/app/summary-panel.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import { useSnapshotQuery } from "../queries/index.js";
import {
  activityRecord,
  type ActivityRecord,
  type ActivityRunDetailView,
  type ActivityStepView,
  type UnmatchedEventDetailView,
} from "./functions.js";
import {
  DROP_REASONS,
  formatBytes,
  formatDuration,
  PREVIEW_CUT,
  resourceLabel,
  runSession,
  runStatusTone,
  sessionLink,
  sessionVisibility,
  stepStatusTone,
  type DropReasonNextStep,
} from "./presentation.js";
import { activityProviderLabel, type ActivitySearch } from "./query-contract.js";
import type { JsonPreview } from "./store.js";

/**
 * The record open beside the Activity list: a run with its steps, prompt, and payload, or an
 * unmatched event with why it started nothing and what to do about it. The record loads when it
 * opens; the list never carries payloads.
 */
export function ActivityDetail({
  organizationSlug,
  kind,
  id,
  neighbours,
  onSelect,
  onClose,
  onFilter,
}: {
  organizationSlug: string;
  kind: "run" | "unmatched";
  id: string;
  neighbours: { previous?: string; next?: string };
  onSelect: (id: string) => void;
  onClose: () => void;
  onFilter: (patch: Pick<ActivitySearch, "reason">) => void;
}) {
  const load = useServerFn(activityRecord);
  const record = useSnapshotQuery({
    queryKey: ["activity-record", organizationSlug, kind, id],
    queryFn: () => load({ data: { organizationSlug, kind, id } }),
  });
  const { previous, next } = neighbours;
  const stepping = {
    ...(previous === undefined ? {} : { onPrevious: () => onSelect(previous) }),
    ...(next === undefined ? {} : { onNext: () => onSelect(next) }),
  };
  const frame = { open: true, onClose, ...stepping } as const;

  if (record.status === "pending") {
    return (
      <DetailSheet {...frame} title={undefined}>
        <CardSkeleton lines={4} />
      </DetailSheet>
    );
  }
  if (record.status === "error") {
    return (
      <DetailSheet {...frame} title={kind === "run" ? "Run" : "Event"}>
        <FailureAlert
          title="Record unavailable"
          error={record.error}
          fallback="Hub couldn't load this record"
          onRetry={record.refetch}
        />
      </DetailSheet>
    );
  }
  return (
    <RecordSheet
      record={record.data}
      frame={frame}
      organizationSlug={organizationSlug}
      onFilter={onFilter}
    />
  );
}

function RecordSheet({
  record,
  frame,
  organizationSlug,
  onFilter,
}: {
  record: ActivityRecord;
  frame: { open: true; onClose: () => void; onPrevious?: () => void; onNext?: () => void };
  organizationSlug: string;
  onFilter: (patch: Pick<ActivitySearch, "reason">) => void;
}) {
  if (record.kind === "missing") {
    return (
      <DetailSheet {...frame} title="Not found">
        <EmptyState
          title="This record is no longer here"
          description="Events no trigger matched are kept for 7 days"
        />
      </DetailSheet>
    );
  }
  if (record.kind === "run") {
    const { run } = record;
    return (
      <DetailSheet
        {...frame}
        title={run.triggerName}
        description={describe([run.source, run.repo, formatAbsolute(run.receivedAt)])}
        status={{ label: statusLabel(run.status), tone: runStatusTone(run.status) }}
        actions={<RunActions run={run} organizationSlug={organizationSlug} />}
      >
        <RunBody run={run} />
      </DetailSheet>
    );
  }
  const { event } = record;
  const reason = DROP_REASONS[event.reason];
  return (
    <DetailSheet
      {...frame}
      title={event.source}
      description={describe([
        activityProviderLabel(event.provider),
        event.repo,
        formatAbsolute(event.receivedAt),
      ])}
      status={{ label: reason.label, tone: reason.tone }}
    >
      <UnmatchedBody event={event} organizationSlug={organizationSlug} onFilter={onFilter} />
    </DetailSheet>
  );
}

function describe(parts: readonly (string | null)[]): string {
  return parts.filter((part) => part !== null && part !== "").join(" · ");
}

function RunActions({
  run,
  organizationSlug,
}: {
  run: ActivityRunDetailView;
  organizationSlug: string;
}) {
  const execution = runSession(run.steps);
  return (
    <>
      {execution === undefined ? null : (
        <Button asChild size="sm">
          <a href={sessionLink(execution)}>
            <ExternalLink aria-hidden="true" /> Open in Paseo
          </a>
        </Button>
      )}
      {run.triggerId === null ? null : (
        <Button asChild size="sm" variant="outline">
          <Link
            to="/o/$organizationSlug/triggers/$triggerId"
            params={{ organizationSlug, triggerId: run.triggerId }}
          >
            Edit trigger
          </Link>
        </Button>
      )}
      <CopyPageLink />
    </>
  );
}

const FAILURE_TITLES: Readonly<Record<string, string>> = {
  failed: "Run failed",
  timed_out: "Run timed out",
  rejected: "Run rejected",
};

function RunBody({ run }: { run: ActivityRunDetailView }) {
  const failure = FAILURE_TITLES[run.status];
  const session = runSession(run.steps);
  const visibility = session === undefined ? undefined : sessionVisibility(session);
  const timed = run.steps.some((step) => step.startedAt !== null);
  const rows: SummaryRow[] = [
    { label: "Daemon", value: run.daemon?.slug ?? "None" },
    {
      label: "Agent",
      value: run.agent === null ? "None" : describe([run.agent.provider, run.agent.model]),
    },
    { label: "Duration", value: formatDuration(run.durationMs) },
    {
      label: "Session",
      value:
        session === undefined
          ? "None"
          : describe([
              session.sessionAction === null ? null : statusLabel(session.sessionAction),
              session.daemonAgentId,
            ]),
    },
    { label: "Started", value: formatAbsolute(run.createdAt) },
    {
      label: "Completed",
      value: run.completedAt === null ? "Still running" : formatAbsolute(run.completedAt),
    },
    { label: "Delivery ID", identifier: run.deliveryId },
  ];
  return (
    <>
      {failure === undefined ? null : (
        <Section>
          <FailureAlert
            title={failure}
            error={run.failureReason}
            fallback="No reason was recorded"
          />
        </Section>
      )}
      {visibility === undefined ? null : (
        <Section>
          <NoticeAlert tone="neutral" title="Where to find this agent">
            {visibility}
          </NoticeAlert>
        </Section>
      )}
      <Section>
        <SummaryPanel label="Run" rows={rows} />
      </Section>
      {run.steps.length === 0 ? null : (
        <Section title="Steps">
          <Card>
            <RecordList label="Steps">
              {run.steps.map((step) => (
                <RecordRow
                  key={step.id}
                  status={
                    <StatusPill tone={stepStatusTone(step.status)}>
                      {statusLabel(step.status)}
                    </StatusPill>
                  }
                  // The column only holds its width when a step has a time to put in it, so the
                  // pills line up across steps without leaving a gap after them when none does.
                  {...(timed
                    ? {
                        actions: (
                          <span className="w-16 text-right text-sm text-muted-foreground tabular-nums">
                            {stepDuration(step.startedAt, step.completedAt)}
                          </span>
                        ),
                      }
                    : {})}
                >
                  <TwoLine
                    primary={stepName(step)}
                    {...(step.failureReason === null ? {} : { secondary: step.failureReason })}
                  />
                </RecordRow>
              ))}
            </RecordList>
          </Card>
          {run.steps.map((step) =>
            step.output === null ? null : (
              <JsonDisclosure
                key={step.id}
                id={`step-output-${step.id}`}
                title={`${stepName(step)} output`}
                preview={step.output}
              />
            ),
          )}
        </Section>
      )}
      <Section title="Prompt">
        <CodeBlock label="Prompt">{run.prompt === "" ? "No prompt" : run.prompt}</CodeBlock>
      </Section>
      <Section>
        <Payload payload={run.payload} />
      </Section>
    </>
  );
}

function stepName(step: ActivityStepView): string {
  return `${String(step.ordinal + 1)}. ${step.stepId}`;
}

function stepDuration(startedAt: string | null, completedAt: string | null): string {
  if (startedAt === null) return "";
  const end = completedAt === null ? Date.now() : new Date(completedAt).getTime();
  return formatDuration(Math.max(0, end - new Date(startedAt).getTime()));
}

function UnmatchedBody({
  event,
  organizationSlug,
  onFilter,
}: {
  event: UnmatchedEventDetailView;
  organizationSlug: string;
  onFilter: (patch: Pick<ActivitySearch, "reason">) => void;
}) {
  const reason = DROP_REASONS[event.reason];
  const rows: SummaryRow[] = [
    { label: "Provider", value: activityProviderLabel(event.provider) },
    { label: "Connection", value: event.connectionSlug ?? "None" },
    { label: resourceLabel(event.provider), value: event.repo ?? event.resourceId ?? "None" },
    { label: "Drop reason", identifier: event.reason },
    { label: "Received", value: formatAbsolute(event.receivedAt) },
    { label: "Delivery ID", identifier: event.deliveryId },
  ];
  return (
    <>
      <Section>
        <Card title={reason.title} description={reason.explanation}>
          <div className="flex flex-wrap items-center gap-2">
            <NextStep step={reason.next} organizationSlug={organizationSlug} />
            <Button size="sm" variant="outline" onClick={() => onFilter({ reason: event.reason })}>
              Filter by this reason
            </Button>
          </div>
        </Card>
      </Section>
      <Section>
        <SummaryPanel label="Event" rows={rows} />
      </Section>
      <Section>
        <Payload payload={event.payload} />
      </Section>
    </>
  );
}

function NextStep({
  step,
  organizationSlug,
}: {
  step: DropReasonNextStep;
  organizationSlug: string;
}) {
  const params = { organizationSlug };
  if (step === "check_integrations") {
    return (
      <Button asChild size="sm" variant="outline">
        <Link to="/o/$organizationSlug/integrations" params={params}>
          Check integrations
        </Link>
      </Button>
    );
  }
  if (step === "view_triggers") {
    return (
      <Button asChild size="sm" variant="outline">
        <Link to="/o/$organizationSlug/triggers" params={params}>
          View triggers
        </Link>
      </Button>
    );
  }
  return (
    <Button asChild size="sm" variant="outline">
      <Link
        to="/o/$organizationSlug/triggers/$triggerId"
        params={{ organizationSlug, triggerId: "new" }}
      >
        Create trigger
      </Link>
    </Button>
  );
}

/** The stored event, indented, behind a disclosure: most readers open a record for the facts above it. */
function Payload({ payload }: { payload: ActivityRunDetailView["payload"] }) {
  return (
    <JsonDisclosure
      id="event-payload"
      title="Event payload"
      preview={payload}
      size={formatBytes(payload.bytes)}
    />
  );
}

/** Stored JSON, closed until asked for, saying when the preview stops short of the whole. */
function JsonDisclosure({
  id,
  title,
  preview,
  size,
}: {
  id: string;
  title: string;
  preview: JsonPreview;
  size?: string;
}) {
  const [open, setOpen] = useState(false);
  const status = [size, preview.truncated ? PREVIEW_CUT : undefined]
    .filter((part) => part !== undefined)
    .join(" · ");
  return (
    <Disclosure
      id={id}
      open={open}
      onOpenChange={setOpen}
      title={title}
      {...(status === "" ? {} : { status })}
    >
      <CodeBlock label={title}>{preview.text}</CodeBlock>
    </Disclosure>
  );
}
