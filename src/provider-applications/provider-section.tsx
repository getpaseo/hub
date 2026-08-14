/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop, typescript-eslint/no-unsafe-type-assertion -- each section owns callbacks bound to its own provider, the glyph and pill are the disclosure header's own slots, and the server functions are typed through the provider-applications boundary */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApplicationField, StoredValue } from "../components/app/application-field.js";
import { CopyBlock, CopyField } from "../components/app/copy-field.js";
import { Disclosure } from "../components/app/disclosure.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { StatusPill } from "../components/app/status-pill.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { FieldSet } from "../components/ui/field.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import type { Result } from "../contract/respond.js";
import { cn } from "../lib/utils.js";
import {
  guideUrl,
  identityLabel,
  isSecureOrigin,
  slackManifest,
  statusPresentation,
  type GuideStep,
  type ProviderGuide,
  type StepSegment,
} from "./guides.js";
import { beginProviderConnection, verifyAndSaveProviderApplication } from "./functions.js";
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
  const [replacing, setReplacing] = useState(false);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [outcome, setOutcome] = useState<Outcome | undefined>(returned);
  const result = useRef<HTMLDivElement>(null);
  const error = useRef<HTMLDivElement>(null);
  const replace = useRef<HTMLButtonElement>(null);
  // Every transition the operator caused ends here: the section says what happened, and the
  // keyboard lands on it rather than on the document body a disabled form left behind.
  useEffect(() => {
    if (outcome?.tone === "error") error.current?.focus();
    else if (outcome !== undefined) result.current?.focus();
  }, [outcome]);
  useEffect(() => {
    if (replacing) document.getElementById(`${guide.provider}-${guide.fields[0]?.name}`)?.focus();
  }, [guide, replacing]);

  const save = useMutation({
    mutationFn: useServerFn(verifyAndSaveProviderApplication) as (
      input: Parameters<typeof verifyAndSaveProviderApplication>[0],
    ) => Promise<SaveResponse>,
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
      setOutcome({
        tone: "success",
        message: `${guide.verifiedMessage ?? ""} ${identityLabel(response.data.identity)}`.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: ["provider-applications"] });
    },
    onError: () => setOutcome({ tone: "error", message: unreachable(guide.name) }),
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

  const pending = save.isPending || connect.isPending;
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
      for (const field of guide.fields) {
        const value = form.get(field.name);
        const text = typeof value === "string" ? value.trim() : "";
        if (text.length === 0) missing[field.name] = field.required;
        else values[field.name] = field.kind === "text" ? text : rawValue(form, field.name);
      }
      setErrors(missing);
      if (Object.keys(missing).length > 0) return;
      const expectedVersion =
        view.configurationVersion === null || view.configurationVersion === 0
          ? {}
          : { expectedVersion: view.configurationVersion };
      save.mutate({
        data: { provider: guide.provider, surface, ...expectedVersion, ...values },
      } as Parameters<typeof verifyAndSaveProviderApplication>[0]);
    },
    [guide, save, surface, view.configurationVersion],
  );

  const startConnection = useCallback(() => {
    connect.mutate({ data: { provider: guide.provider, organizationId, surface } });
  }, [connect, guide.provider, organizationId, surface]);

  const status = statusPresentation(view.status);
  const secure = isSecureOrigin(callbackOrigin);
  const blocked = guide.requiresHttps && !secure;
  const editing = view.status === "notConfigured" || replacing;
  const showForm = !view.managedByEnvironment && editing;
  const formId = `${guide.provider}-application-form`;

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
      <div className="grid gap-6">
        {view.managedByEnvironment ? (
          <Alert>
            <AlertDescription>Set by this Hub's environment. Change it there.</AlertDescription>
          </Alert>
        ) : null}
        {secure ? null : <InsecureOriginNotice guide={guide} origin={callbackOrigin} />}
        <Steps guide={guide} origin={callbackOrigin} />
        {showForm ? (
          // The actions sit outside the form so the result region below can be one element that
          // survives the switch to the saved view — focus moved to a node that then unmounts is
          // focus dropped on the floor.
          <form id={formId} aria-label={`Set up ${guide.name}`} aria-busy={busy} onSubmit={submit}>
            <FieldSet className="max-w-md gap-4" disabled={busy || blocked}>
              {guide.fields.map((field) => (
                <ApplicationField
                  key={field.name}
                  id={`${guide.provider}-${field.name}`}
                  name={field.name}
                  label={field.label}
                  kind={field.kind}
                  {...(field.description === undefined ? {} : { description: field.description })}
                  {...(errors[field.name] === undefined ? {} : { error: errors[field.name] })}
                  {...storedDefault(identifierValue(view, field.identifier))}
                />
              ))}
            </FieldSet>
          </form>
        ) : (
          <div className="grid max-w-md gap-3 sm:grid-cols-2">
            {guide.fields.map((field) => (
              <StoredValue
                key={field.name}
                label={field.label}
                value={identifierValue(view, field.identifier)}
              />
            ))}
          </div>
        )}
        <ResultRegion ref={result} errorRef={error} view={view} guide={guide} outcome={outcome} />
        <div>
          <Actions>
            {showForm ? (
              <Button type="submit" form={formId} disabled={busy || blocked}>
                {save.isPending || leaving ? guide.actions.savePending : guide.actions.save}
              </Button>
            ) : (
              <ConnectAction
                guide={guide}
                view={view}
                busy={busy}
                blocked={blocked}
                pending={connect.isPending || leaving}
                onConnect={startConnection}
              />
            )}
            <SecondaryAction
              busy={busy}
              editing={showForm}
              replacing={replacing}
              managed={view.managedByEnvironment}
              replaceRef={replace}
              onCancel={() => {
                setReplacing(false);
                requestAnimationFrame(() => replace.current?.focus());
              }}
              onReplace={() => {
                setErrors({});
                setOutcome(undefined);
                setReplacing(true);
              }}
            />
          </Actions>
          <SaveNotes guide={guide} editing={showForm} replacing={replacing} />
        </div>
      </div>
    </Disclosure>
  );
}

/** Keeps an absent identifier absent rather than present-and-undefined. */
function storedDefault(value: string | undefined): { defaultValue?: string } {
  return value === undefined ? {} : { defaultValue: value };
}

function identifierValue(
  view: ProviderApplicationView,
  identifier: string | undefined,
): string | undefined {
  return identifier === undefined ? undefined : view.identifiers[identifier];
}

/** Cancel while replacing, Replace once something is stored, nothing when the environment owns it. */
function SecondaryAction({
  busy,
  editing,
  replacing,
  managed,
  replaceRef,
  onCancel,
  onReplace,
}: {
  busy: boolean;
  editing: boolean;
  replacing: boolean;
  managed: boolean;
  replaceRef: React.RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onReplace: () => void;
}) {
  if (editing) {
    if (!replacing) return null;
    return (
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    );
  }
  if (managed) return null;
  return (
    <Button ref={replaceRef} type="button" variant="ghost" disabled={busy} onClick={onReplace}>
      Replace credentials
    </Button>
  );
}

function SaveNotes({
  guide,
  editing,
  replacing,
}: {
  guide: ProviderGuide;
  editing: boolean;
  replacing: boolean;
}) {
  if (!editing) return null;
  return (
    <>
      {guide.saveHint === undefined ? null : (
        <p className="mt-2 text-sm text-muted-foreground">{guide.saveHint}</p>
      )}
      {replacing ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Rotating secrets for the same app keeps your connections. Setting up a different app does
          not.
        </p>
      ) : null}
    </>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse sm:justify-end">{children}</div>
  );
}

function ConnectAction({
  guide,
  view,
  busy,
  blocked,
  pending,
  onConnect,
}: {
  guide: ProviderGuide;
  view: ProviderApplicationView;
  busy: boolean;
  blocked: boolean;
  pending: boolean;
  onConnect: () => void;
}) {
  const label =
    view.connections.length > 0 ? guide.actions.connectAgain : (guide.actions.connect ?? undefined);
  if (label === undefined) return null;
  return (
    <Button type="button" disabled={busy || blocked} onClick={onConnect}>
      {pending ? "Opening…" : label}
    </Button>
  );
}

/**
 * The one place a section speaks about state. Identity, connections, and the event line are
 * facts the boundary reported; the outcome alert is what just happened. They stack rather than
 * replace each other, so a failed verify never erases the app that is still working.
 */
function ResultRegion({
  ref,
  errorRef,
  view,
  guide,
  outcome,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  errorRef: React.RefObject<HTMLDivElement | null>;
  view: ProviderApplicationView;
  guide: ProviderGuide;
  outcome: Outcome | undefined;
}) {
  const empty = view.identity === null && view.connections.length === 0 && outcome === undefined;
  return (
    <div
      ref={ref}
      role="status"
      tabIndex={-1}
      aria-label={`${guide.name} status`}
      className={cn("grid gap-2 outline-none", empty ? "sr-only" : "")}
    >
      {view.identity === null ? null : <p className="text-sm">{identityLabel(view.identity)}</p>}
      {view.connections.map((connection) => (
        <p key={connection.id} className="text-sm">
          Connected to {connection.name}.
        </p>
      ))}
      {guide.receivesEvents && view.connections.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          {view.lastEventAt === null ? (
            "Waiting for an event"
          ) : (
            <>
              Last event <RelativeTime value={view.lastEventAt} />
            </>
          )}
        </p>
      ) : null}
      <OutcomeMessage ref={errorRef} outcome={outcome} />
    </div>
  );
}

function OutcomeMessage({
  ref,
  outcome,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  outcome: Outcome | undefined;
}) {
  if (outcome === undefined) return null;
  if (outcome.tone === "error") {
    return (
      <Alert ref={ref} tabIndex={-1} variant="destructive">
        <AlertDescription>{outcome.message}</AlertDescription>
      </Alert>
    );
  }
  return <p className="text-sm">{outcome.message}</p>;
}

function InsecureOriginNotice({ guide, origin }: { guide: ProviderGuide; origin: string }) {
  const notice = guide.insecureOriginNotice(origin);
  return (
    <Alert
      {...(notice.tone === "warning" ? { className: "border-warning/40 bg-warning-surface" } : {})}
    >
      <AlertDescription>{notice.message}</AlertDescription>
    </Alert>
  );
}

function Steps({ guide, origin }: { guide: ProviderGuide; origin: string }) {
  return (
    <div className="grid gap-3">
      <ol className="grid list-decimal gap-4 pl-5 text-sm marker:text-muted-foreground">
        {guide.steps.map((step) => (
          <li key={stepKey(step)} className="pl-1">
            <StepBody guide={guide} step={step} origin={origin} />
          </li>
        ))}
      </ol>
      {guide.note === undefined ? null : (
        <p className="text-sm text-muted-foreground">{guide.note}</p>
      )}
    </div>
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
  return (
    <>
      <span>
        {step.segments.map((segment) => (
          <Segment key={`${segment.kind}:${segment.value}`} segment={segment} />
        ))}
      </span>
      {urls.length === 0 ? null : (
        <div className="mt-3 grid gap-3">
          {urls.map((url) => (
            <CopyField key={url.key} label={url.label} value={guideUrl(origin, url.path)} />
          ))}
        </div>
      )}
      {step.manifest === true ? (
        <div className="mt-3">
          <CopyBlock label="App manifest" value={slackManifest(origin)} action="Copy manifest" />
        </div>
      ) : null}
    </>
  );
}

function Segment({ segment }: { segment: StepSegment }) {
  if (segment.kind === "term") return <strong className="font-medium">{segment.value}</strong>;
  if (segment.kind === "link") {
    return (
      <a
        href={segment.href}
        target="_blank"
        rel="noreferrer"
        // Underlined always, not on hover: an inline link in a paragraph has to be
        // distinguishable without colour.
        className="inline-flex items-center gap-1 text-link underline underline-offset-4"
      >
        {segment.value}
        <ExternalLink aria-hidden="true" className="size-3" />
      </a>
    );
  }
  return <span>{segment.value}</span>;
}

function stepKey(step: GuideStep): string {
  return step.segments.map((segment) => segment.value).join("");
}

function rawValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function unreachable(name: string): string {
  return `We couldn't reach ${name}. Try again.`;
}
