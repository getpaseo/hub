/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop, typescript-eslint/no-unsafe-type-assertion -- each section owns callbacks bound to its own provider, the glyph and pill are the disclosure header's own slots, and the server functions are typed through the provider-applications boundary */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Card, CardSkeleton } from "../components/app/card.js";
import { FormField } from "../components/app/form-field.js";
import { CopyBlock, CopyField } from "../components/app/copy-field.js";
import { Disclosure } from "../components/app/disclosure.js";
import { FailureAlert, NoticeAlert, WarningAlert } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { SegmentedControl, type SegmentedOption } from "../components/app/segmented-control.js";
import { StatusLine } from "../components/app/status-line.js";
import { StatusPill } from "../components/app/status-pill.js";
import { SummaryPanel, type SummaryRow } from "../components/app/summary-panel.js";
import { Button } from "../components/ui/button.js";
import { FieldSet } from "../components/ui/field.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import type { Result } from "../contract/respond.js";
import { cn } from "../lib/utils.js";
import {
  guideFields,
  guideGroups,
  guideUrl,
  isSecureOrigin,
  SLACK_WEBHOOK_GUIDE,
  slackManifest,
  statusPresentation,
  type GuideGroup,
  type GuideStep,
  type ProviderGuide,
  type StepSegment,
} from "./guides.js";
import {
  beginProviderConnection,
  configureSlackSocketApplication,
  retrySlackSocketDelivery,
  verifyAndSaveProviderApplication,
} from "./functions.js";
import type {
  ProviderApplicationSaveResult,
  ProviderApplicationSurface,
  ProviderApplicationView,
} from "./index.js";

export interface SectionReturn {
  tone: "success" | "error";
  message: string;
}

interface Outcome {
  tone: "success" | "error";
  message: string;
}

type SaveResponse = Result<ProviderApplicationSaveResult>;
type ConnectResponse = Result<{ url: string }>;
type VoidResponse = Result<void>;
interface SaveMutationInput {
  data: Record<string, unknown> & { provider: string; transport?: "socket" | "webhook" };
}

// eslint-disable-next-line complexity -- this component owns one provider card's complete workflow.
export function ProviderSection({
  guide,
  view,
  callbackOrigin,
  surface,
  organizationId,
  open,
  onOpenChange,
  returned,
}: {
  guide: ProviderGuide;
  view: ProviderApplicationView;
  callbackOrigin: string;
  surface: ProviderApplicationSurface;
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The outcome of an install or authorization that just came back to this section. */
  returned: SectionReturn | undefined;
}) {
  const queryClient = useQueryClient();
  const savedSlackTransport = view.identifiers["transport"] === "webhook" ? "webhook" : "socket";
  const [slackTransport, setSlackTransport] = useState<"socket" | "webhook">(savedSlackTransport);
  const activeGuide =
    guide.provider === "slack" && slackTransport === "webhook" ? SLACK_WEBHOOK_GUIDE : guide;
  const [replacing, setReplacing] = useState(false);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [outcome, setOutcome] = useState<Outcome | undefined>(returned);
  const result = useRef<HTMLDivElement>(null);
  const replace = useRef<HTMLButtonElement>(null);
  const fields = guideFields(activeGuide, callbackOrigin);
  // Every transition the operator caused ends here: the section says what happened, and the
  // keyboard lands on it rather than on the document body a disabled form left behind. A
  // failure takes the keyboard onto the alert itself, so only a success needs the region.
  useEffect(() => {
    if (outcome?.tone === "success") result.current?.focus();
  }, [outcome]);
  useEffect(() => {
    if (replacing) document.getElementById(`${activeGuide.provider}-${fields[0]?.name}`)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the first field name is stable per guide
  }, [activeGuide, replacing]);

  const saveProvider = useServerFn(verifyAndSaveProviderApplication) as (
    input: SaveMutationInput,
  ) => Promise<SaveResponse>;
  const saveSocket = useServerFn(configureSlackSocketApplication);

  const save = useMutation({
    mutationFn: (input: SaveMutationInput) => {
      if (input.data.provider !== "slack" || input.data.transport !== "socket") {
        return saveProvider(input);
      }
      const { appToken, botToken, expectedVersion } = input.data;
      if (typeof appToken !== "string" || typeof botToken !== "string") {
        return Promise.reject(new Error("invalid Slack Socket Mode form"));
      }
      return saveSocket({
        data: {
          appToken,
          botToken,
          ...(typeof expectedVersion === "number" ? { expectedVersion } : {}),
        },
      });
    },
    onSuccess: async (response) => {
      if (response.status === "error") {
        setOutcome({ tone: "error", message: response.error.message });
        return;
      }
      // Slack's save is its install: it leaves for Slack and nothing is stored until Slack
      // accepts. There is no local success to report here.
      if (response.data.status === "continuing") {
        window.location.assign(response.data.url);
        return;
      }
      setReplacing(false);
      setOutcome({ tone: "success", message: activeGuide.verifiedMessage ?? "" });
      await queryClient.invalidateQueries({ queryKey: ["provider-applications"] });
    },
    onError: () => setOutcome({ tone: "error", message: unreachable(activeGuide.name) }),
  });

  const connect = useMutation({
    mutationFn: useServerFn(beginProviderConnection) as (
      input: Parameters<typeof beginProviderConnection>[0],
    ) => Promise<ConnectResponse>,
    onSuccess: (response) => {
      if (response.status === "error") {
        setOutcome({ tone: "error", message: response.error.message });
        return;
      }
      window.location.assign(response.data.url);
    },
    onError: () => setOutcome({ tone: "error", message: unreachable(guide.name) }),
  });
  const retryDelivery = useMutation({
    mutationFn: useServerFn(retrySlackSocketDelivery) as (input: {}) => Promise<VoidResponse>,
    onSuccess: async (response) => {
      if (response.status === "error") {
        setOutcome({ tone: "error", message: response.error.message });
        return;
      }
      setOutcome({ tone: "success", message: "Slack is reconnecting." });
      await queryClient.invalidateQueries({ queryKey: ["provider-applications"] });
    },
    onError: () => setOutcome({ tone: "error", message: unreachable("Slack") }),
  });

  const pending = save.isPending || connect.isPending || retryDelivery.isPending;
  // A save that resolved into a redirect keeps the section busy until the browser leaves, so the
  // form cannot be submitted twice in the gap.
  const leaving =
    (save.isSuccess && save.data.status === "ok" && save.data.data.status === "continuing") ||
    (connect.isSuccess && connect.data.status === "ok");
  const busy = pending || leaving;

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const missing: Record<string, string> = {};
      const values: Record<string, string> = {};
      for (const field of fields) {
        const value = form.get(field.name);
        const text = typeof value === "string" ? value.trim() : "";
        if (text.length === 0) {
          if (field.optional !== true) missing[field.name] = field.required;
          continue;
        }
        values[field.name] = field.kind === "text" ? text : rawValue(form, field.name);
      }
      setErrors(missing);
      if (Object.keys(missing).length > 0) return;
      const expectedVersion =
        view.configurationVersion === null || view.configurationVersion === 0
          ? {}
          : { expectedVersion: view.configurationVersion };
      save.mutate({
        data: {
          provider: activeGuide.provider,
          ...(activeGuide.transport === undefined ? {} : { transport: activeGuide.transport }),
          surface,
          ...expectedVersion,
          ...values,
        },
      });
    },
    [activeGuide, fields, save, surface, view.configurationVersion],
  );

  const startConnection = useCallback(() => {
    connect.mutate({ data: { provider: guide.provider, organizationId, surface } });
  }, [connect, guide.provider, organizationId, surface]);

  const status = statusPresentation(view.status);
  // Once anything is saved the instructions become reference material and move behind a
  // disclosure, so completed work is never buried under the manual that created it.
  const phase = sectionPhase(activeGuide, view, callbackOrigin, replacing);

  const form =
    phase === "guiding" || phase === "replacing" ? (
      <PasteForm
        id={`${activeGuide.provider}-application-form`}
        guide={activeGuide}
        origin={callbackOrigin}
        errors={errors}
        view={view}
        busy={busy}
        replacing={replacing}
        pendingLabel={save.isPending || leaving ? guide.actions.savePending : undefined}
        onSubmit={submit}
        onCancel={() => {
          setReplacing(false);
          requestAnimationFrame(() => replace.current?.focus());
        }}
      />
    ) : null;

  return (
    <Disclosure
      id={guide.provider}
      open={open}
      onOpenChange={onOpenChange}
      media={<ProviderGlyph provider={guide.provider} />}
      title={guide.name}
      description={guide.summary}
      status={<StatusPill tone={status.tone}>{status.label}</StatusPill>}
    >
      <div className="grid gap-5">
        {view.managedByEnvironment ? <EnvironmentNotice guide={activeGuide} /> : null}
        {/* One node for the whole life of the section. A save moves the section from setup to
            saved, and focus that had just landed on a node the phase change unmounts is focus
            dropped on the floor. */}
        <ResultRegion ref={result} guide={activeGuide} outcome={outcome} />
        {guide.provider === "slack" &&
        (phase === "guiding" || phase === "replacing" || phase === "blocked") ? (
          <SlackTransportChoice value={slackTransport} onChange={setSlackTransport} />
        ) : null}
        <SectionBody
          guide={activeGuide}
          view={view}
          origin={callbackOrigin}
          phase={phase}
          form={form}
          busy={busy}
          connecting={connect.isPending || leaving}
          replaceRef={replace}
          onConnect={startConnection}
          onRetry={() => retryDelivery.mutate({})}
          onReplace={() => {
            setErrors({});
            setOutcome(undefined);
            setReplacing(true);
          }}
        />
      </div>
    </Disclosure>
  );
}

/**
 * Which of the four things a section can be showing. Keeping it a single value rather than a
 * knot of booleans is what stops "verified" and "replacing" from disagreeing about the layout.
 */
type SectionPhase = "blocked" | "guiding" | "replacing" | "saved";

const TRANSPORT_QUESTION = "How should Slack reach Hub?";

/** What the chosen transport asks of the operator, said once, under the control that picks it. */
const SLACK_TRANSPORTS: readonly SegmentedOption[] = [
  {
    value: "socket",
    label: "Socket Mode",
    hint: "Connect from this Hub to Slack. No public address or HTTPS needed.",
  },
  {
    value: "webhook",
    label: "Webhooks",
    hint: "Let Slack send events to a public HTTPS address.",
  },
];

function SlackTransportChoice({
  value,
  onChange,
}: {
  value: "socket" | "webhook";
  onChange: (value: "socket" | "webhook") => void;
}) {
  const choose = useCallback(
    (next: string) => onChange(next === "webhook" ? "webhook" : "socket"),
    [onChange],
  );
  return (
    <SegmentedControl
      label={TRANSPORT_QUESTION}
      description={TRANSPORT_QUESTION}
      value={value}
      options={SLACK_TRANSPORTS}
      onChange={choose}
    />
  );
}

function sectionPhase(
  guide: ProviderGuide,
  view: ProviderApplicationView,
  origin: string,
  replacing: boolean,
): SectionPhase {
  if (guide.requiresHttps && !isSecureOrigin(origin)) return "blocked";
  if (view.managedByEnvironment) return "saved";
  if (replacing) return "replacing";
  return view.status === "notConfigured" ? "guiding" : "saved";
}

function SectionBody({
  guide,
  view,
  origin,
  phase,
  form,
  busy,
  connecting,
  replaceRef,
  onConnect,
  onRetry,
  onReplace,
}: {
  guide: ProviderGuide;
  view: ProviderApplicationView;
  origin: string;
  phase: SectionPhase;
  form: ReactNode;
  busy: boolean;
  connecting: boolean;
  replaceRef: React.RefObject<HTMLButtonElement | null>;
  onConnect: () => void;
  onRetry: () => void;
  onReplace: () => void;
}) {
  if (phase === "blocked") return <HttpsGate guide={guide} origin={origin} />;
  if (phase === "guiding") {
    // The task layout. Instructions read down one column while the values they produce land in a
    // bounded panel beside them, so the form is never a narrow strip under a wide wall of text.
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:items-start lg:gap-8">
        <Instructions guide={guide} origin={origin} />
        {form}
      </div>
    );
  }
  return (
    <div className="grid gap-5">
      {phase === "replacing" ? (
        <div className="lg:max-w-md">{form}</div>
      ) : (
        <>
          <SummaryPanel label={`${guide.name} app`} rows={summaryRows(guide, view, origin)} />
          {/* `FormActions` puts the last child on the right, so the filled connect button is last. */}
          <FormActions>
            {view.managedByEnvironment ? null : (
              <Button
                ref={replaceRef}
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onReplace}
              >
                Replace credentials
              </Button>
            )}
            {guide.provider === "slack" &&
            view.identifiers["transport"] === "socket" &&
            view.deliveryStatus?.state === "actionNeeded" ? (
              <Button type="button" variant="outline" disabled={busy} onClick={onRetry}>
                Retry
              </Button>
            ) : null}
            <ConnectAction
              guide={guide}
              view={view}
              busy={busy}
              pending={connecting}
              onConnect={onConnect}
            />
          </FormActions>
        </>
      )}
      <SetupSteps guide={guide} origin={origin} />
    </div>
  );
}

/** Static setup guidance remains useful while only persisted status and credentials are loading. */
export function ProviderSectionLoading({ guide, open }: { guide: ProviderGuide; open: boolean }) {
  return (
    <div aria-busy="true">
      <Disclosure
        id={guide.provider}
        open={open}
        onOpenChange={ignoreLoadingDisclosureChange}
        media={<ProviderGlyph provider={guide.provider} />}
        title={guide.name}
        description={guide.summary}
        status={<Skeleton className="h-5 w-24 rounded-full" />}
      >
        {/* The page being waited for is a card of instructions beside a card of fields. */}
        <CardSkeleton />
      </Disclosure>
    </div>
  );
}

function ignoreLoadingDisclosureChange(): void {}

/**
 * What the app is and what it is doing, once there is something to say. Every fact is one
 * labelled row; nothing here restates a fact the status pill already gave.
 */
function summaryRows(
  guide: ProviderGuide,
  view: ProviderApplicationView,
  origin: string,
): readonly SummaryRow[] {
  const rows: SummaryRow[] = [];
  const identity = view.identity;
  if (identity !== null) {
    // Slack's OAuth response carries no app name, only the App ID, so that is what is shown —
    // rather than a placeholder dressed up as one.
    const value = identity.provider === "slack" ? identity.id : identity.name;
    rows.push({ label: guide.summaryLabels.identity, value });
    if (guide.summaryLabels.owner !== undefined && identity.provider === "github") {
      rows.push({ label: guide.summaryLabels.owner, value: identity.ownerLogin });
    }
    if (identity.provider === "discord") {
      rows.push({ label: "Application ID", value: identity.id });
    }
  }
  if (guide.provider === "slack") {
    rows.push({
      label: "Delivery",
      value: view.identifiers["transport"] === "webhook" ? "Webhooks" : "Socket Mode",
    });
  }
  rows.push({
    label: guide.summaryLabels.connections,
    value:
      view.connections.length === 0 ? (
        "None yet"
      ) : (
        <ul className="grid gap-1">
          {view.connections.map((connection) => (
            <li key={connection.id} className="flex flex-wrap items-center gap-1.5">
              {connection.name}
              {connection.status === "actionNeeded" ? (
                <StatusPill tone="warning">Needs attention</StatusPill>
              ) : null}
            </li>
          ))}
        </ul>
      ),
  });
  if (guide.receivesEvents) rows.push({ label: "Events", value: eventState(guide, view, origin) });
  if (view.managedByEnvironment) {
    for (const field of guideFields(guide, origin)) {
      if (field.identifier === undefined) continue;
      const value = view.identifiers[field.identifier];
      if (value !== undefined) rows.push({ label: field.label, value });
    }
  }
  return rows;
}

/** Says only what the boundary can prove: a signed delivery arrived, or nothing has yet. */
function eventState(
  guide: ProviderGuide,
  view: ProviderApplicationView,
  origin: string,
): ReactNode {
  if (guide.provider === "slack" && view.identifiers["transport"] === "socket") {
    const socketState = slackSocketEventState(view.deliveryStatus);
    if (socketState !== undefined) return socketState;
  }
  if (guide.provider === "github" && !isSecureOrigin(origin)) {
    return "Needs a public HTTPS address";
  }
  if (!view.eventsConfigured) return "Not set up";
  if (view.connections.length === 0) return "Waiting for a connection";
  if (view.lastEventAt === null) return "Waiting for the first event";
  return (
    <>
      Last received <RelativeTime value={view.lastEventAt} />
    </>
  );
}

function slackSocketEventState(
  delivery: ProviderApplicationView["deliveryStatus"],
): ReactNode | undefined {
  if (delivery?.state === "connected") return <>Connected</>;
  if (delivery?.state === "connecting" || delivery?.state === "reconnecting") {
    return <>Reconnecting</>;
  }
  if (delivery?.state !== "actionNeeded") return undefined;
  const action = {
    socketModeOff: "Turn on Socket Mode in Slack, then retry",
    appIdentityMismatch: "Replace the app-level token with one from this Slack app",
    appTokenRejected: "Replace the app-level token",
  }[delivery.reason];
  return action;
}

/**
 * The bounded panel that holds whatever the operator is pasting. It carries its own heading,
 * its own actions, and its own border, so on a wide screen it reads as the second half of a
 * two-part task rather than as loose inputs floating under the instructions.
 */
function PasteForm({
  id,
  guide,
  origin,
  errors,
  view,
  busy,
  replacing,
  pendingLabel,
  onSubmit,
  onCancel,
}: {
  id: string;
  guide: ProviderGuide;
  origin: string;
  errors: Readonly<Record<string, string>>;
  view: ProviderApplicationView;
  busy: boolean;
  replacing: boolean;
  pendingLabel: string | undefined;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const groups = guideGroups(guide, origin).filter((group) => group.fields.length > 0);
  return (
    <Card
      className="lg:sticky lg:top-6"
      title={replacing ? "Replace credentials" : guide.formTitle}
      {...(replacing
        ? {
            description:
              "Rotating secrets for the same app keeps your connections. Setting up a different app does not.",
          }
        : {})}
    >
      <form
        id={id}
        aria-label={`Set up ${guide.name}`}
        aria-busy={busy}
        onSubmit={onSubmit}
        className="grid gap-4"
      >
        {groups.map((group, index) => (
          <FieldSet key={group.id} className="gap-4" disabled={busy}>
            {group.title === undefined || index === 0 ? null : (
              <p className="border-t pt-4 text-sm text-muted-foreground">
                {group.title} — optional
              </p>
            )}
            {group.fields.map((field) => (
              <FormField
                key={field.name}
                id={`${guide.provider}-${field.name}`}
                name={field.name}
                label={field.label}
                kind={field.kind}
                {...(field.description === undefined ? {} : { description: field.description })}
                {...(errors[field.name] === undefined ? {} : { error: errors[field.name] })}
                {...storedDefault(
                  field.identifier === undefined ? undefined : view.identifiers[field.identifier],
                )}
              />
            ))}
          </FieldSet>
        ))}
        <FormActions>
          {replacing ? (
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" disabled={busy}>
            {pendingLabel ?? guide.actions.save}
          </Button>
        </FormActions>
        {guide.saveHint === undefined ? null : (
          <p className="text-sm text-muted-foreground">{guide.saveHint}</p>
        )}
      </form>
    </Card>
  );
}

/** Keeps an absent identifier absent rather than present-and-undefined. */
function storedDefault(value: string | undefined): { defaultValue?: string } {
  return value === undefined ? {} : { defaultValue: value };
}

function ConnectAction({
  guide,
  view,
  busy,
  pending,
  onConnect,
}: {
  guide: ProviderGuide;
  view: ProviderApplicationView;
  busy: boolean;
  pending: boolean;
  onConnect: () => void;
}) {
  const label =
    view.connections.length > 0 ? guide.actions.connectAgain : (guide.actions.connect ?? undefined);
  if (
    label === undefined ||
    (guide.provider === "slack" && view.identifiers["transport"] === "socket")
  )
    return null;
  return (
    <Button type="button" disabled={busy} onClick={onConnect}>
      {pending ? "Opening…" : label}
    </Button>
  );
}

/**
 * What just happened, and nothing else. The saved facts live in the summary, so a failed verify
 * stacks its alert above an app that is still working rather than replacing it.
 */
function ResultRegion({
  ref,
  guide,
  outcome,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  guide: ProviderGuide;
  outcome: Outcome | undefined;
}) {
  return (
    <div
      ref={ref}
      role="status"
      tabIndex={-1}
      aria-label={`${guide.name} status`}
      className={cn("grid gap-2 outline-none", outcome === undefined ? "sr-only" : "")}
    >
      <OutcomeMessage guide={guide} outcome={outcome} />
    </div>
  );
}

/** Success and failure are the same event class, so they are the same two shapes every screen uses. */
function OutcomeMessage({
  guide,
  outcome,
}: {
  guide: ProviderGuide;
  outcome: Outcome | undefined;
}) {
  if (outcome === undefined) return null;
  if (outcome.tone === "success") return <StatusLine>{outcome.message}</StatusLine>;
  return (
    <FailureAlert
      title={`${guide.name} setup didn't finish`}
      error={outcome.message}
      fallback={unreachable(guide.name)}
      focusOnArrival
    />
  );
}

function EnvironmentNotice({ guide }: { guide: ProviderGuide }) {
  return (
    <NoticeAlert tone="neutral" title="Managed by environment">
      <p>
        These credentials come from <VariableList names={guide.environmentVariables} />. Change them
        where you set Hub's environment and restart Hub; they cannot be edited here. Connecting{" "}
        {guide.name} still works from this page.
      </p>
    </NoticeAlert>
  );
}

/** Reads as a sentence: "A, B and C". */
function separator(index: number, total: number): string {
  if (index === 0) return "";
  return index === total - 1 ? " and " : ", ";
}

function VariableList({ names }: { names: readonly string[] }) {
  return (
    <>
      {names.map((name, index) => (
        <span key={name}>
          {separator(index, names.length)}
          <code className="font-mono text-xs">{name}</code>
        </span>
      ))}
    </>
  );
}

/** Slack's plain-HTTP state is terminal: the requirement and nothing to press. */
function HttpsGate({ guide, origin }: { guide: ProviderGuide; origin: string }) {
  return <WarningAlert title="HTTPS required">{guide.httpsRequirement(origin)}</WarningAlert>;
}

/**
 * The instructions, after they stop being the job. Collapsed by default and never opened for
 * the operator — a finished section opens showing what it did, not how it was made.
 */
function SetupSteps({ guide, origin }: { guide: ProviderGuide; origin: string }) {
  const [open, setOpen] = useState(false);
  return (
    // Its own id, never the provider's: the surface addresses a section by `data-provider`, and
    // two nodes answering to the same provider is one section too many.
    <Disclosure
      id={`${guide.provider}-setup-steps`}
      open={open}
      onOpenChange={setOpen}
      title="Setup steps"
    >
      <Instructions guide={guide} origin={origin} />
    </Disclosure>
  );
}

function Instructions({ guide, origin }: { guide: ProviderGuide; origin: string }) {
  return (
    <div className="grid min-w-0">
      {guideGroups(guide, origin).map((group) => (
        <InstructionGroup key={group.id} guide={guide} group={group} origin={origin} />
      ))}
    </div>
  );
}

function InstructionGroup({
  guide,
  group,
  origin,
}: {
  guide: ProviderGuide;
  group: GuideGroup;
  origin: string;
}) {
  return (
    <Section
      {...(group.title === undefined ? {} : { title: group.title })}
      {...(group.description === undefined ? {} : { description: group.description })}
    >
      {group.unavailable === undefined ? (
        <ol className="grid list-decimal gap-4 pl-5 text-sm marker:text-muted-foreground">
          {group.steps.map((step) => (
            <li key={stepKey(step)} className="pl-1 text-muted-foreground">
              <StepBody guide={guide} step={step} origin={origin} />
            </li>
          ))}
        </ol>
      ) : (
        <WarningAlert title="Not available at this address">{group.unavailable}</WarningAlert>
      )}
    </Section>
  );
}

function StepBody({
  guide,
  step,
  origin,
}: {
  guide: ProviderGuide;
  step: GuideStep;
  origin: string;
}) {
  const urls = (step.urls ?? []).flatMap((key) => {
    const url = guide.urls.find((candidate) => candidate.key === key);
    return url === undefined ? [] : [url];
  });
  const attachments =
    step.permissions !== undefined ||
    step.events !== undefined ||
    urls.length > 0 ||
    step.manifest === true;
  return (
    <>
      <span>
        {step.segments.map((segment) => (
          <Segment key={`${segment.kind}:${segment.value}`} segment={segment} />
        ))}
      </span>
      {/* One offset from the sentence, then gap between whatever the step attaches to itself. A
          list item cannot be a grid without losing its number, so the grid is this wrapper. */}
      {attachments ? (
        <div className="mt-3 grid gap-3">
          {step.permissions === undefined ? null : (
            <SummaryPanel
              label={`${guide.name} permissions`}
              rows={permissionRows(step.permissions)}
            />
          )}
          {step.events === undefined ? null : (
            <ul className="flex flex-wrap gap-1.5">
              {step.events.map((event) => (
                <li key={event}>
                  <StatusPill tone="neutral" dot={false}>
                    {event}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
          {urls.map((url) => (
            <CopyField key={url.key} label={url.label} value={guideUrl(origin, url.path)} />
          ))}
          {step.manifest === true ? (
            <CopyBlock
              label="App manifest"
              value={slackManifest(origin, guide.transport ?? "socket")}
              action="Copy manifest"
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function Segment({ segment }: { segment: StepSegment }) {
  // Instruction prose is muted; the controls to find in the portal are not. That contrast is
  // what makes a step scannable without relying on font weight.
  if (segment.kind === "term") {
    return <span className="text-foreground">{segment.value}</span>;
  }
  if (segment.kind === "link") {
    return (
      <Button asChild variant="link">
        <a href={segment.href} target="_blank" rel="noreferrer">
          {segment.value}
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      </Button>
    );
  }
  return <span>{segment.value}</span>;
}

/** Each portal control the step names, with the one value it has to be set to. */
function permissionRows(permissions: NonNullable<GuideStep["permissions"]>): readonly SummaryRow[] {
  return permissions.map((permission) => ({ label: permission.name, value: permission.access }));
}

function stepKey(step: GuideStep): string {
  return step.segments.map((segment) => segment.value).join("");
}

function rawValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function unreachable(name: string): string {
  return `Hub did not get an answer while contacting ${name}. Nothing was saved. Check your connection, then try again.`;
}
