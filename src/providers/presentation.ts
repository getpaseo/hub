import type { Result } from "../contract/respond.js";
import type { FailureKind } from "../failures/index.js";
import type {
  ProviderApplicationConfiguration,
  ProviderApplicationSaveResult,
  ProviderApplicationSurface,
  ProviderApplicationView,
} from "../provider-applications/index.js";

/**
 * Presentation unions spelled here rather than imported from the components, so this module stays
 * free of JSX and buildable by the server project. Divergence from `ApplicationField` or
 * `StatusPill` fails where a guide is handed to them, which is the only place it could matter.
 */
type FieldKind = "text" | "secret" | "multiline";
export type Tone = "success" | "warning" | "danger" | "neutral";

/**
 * Everything the app setup surface says, as data. Kept out of the components so the wording,
 * the field order, and the generated URLs can be asserted directly, and so the one rule that
 * matters — a provider's own words, spelled the way that provider spells them — has a single
 * place to be reviewed.
 *
 * Bold `term` segments are labels the external portal uses verbatim. Do not reword them to match
 * Paseo's vocabulary; the operator is reading them off another company's screen.
 */
export type StepSegment =
  | { kind: "text"; value: string }
  | { kind: "term"; value: string }
  | { kind: "link"; value: string; href: string };

export interface GuideStep {
  segments: readonly StepSegment[];
  /** Keys of the guide URLs rendered as copy fields under this step. */
  urls?: readonly string[];
  /** Renders the generated manifest under this step. */
  manifest?: { label: string; action: string; build(origin: string): string };
  /**
   * A portal control and the value to give it, rendered as a mapping. Prose that lists six
   * settings in one sentence is prose nobody checks off against the screen they are on.
   */
  permissions?: readonly { name: string; access: string }[];
  /** Named checkboxes, rendered as a list rather than a comma run-on. */
  events?: readonly string[];
}

export interface GuideUrl {
  key: string;
  label: string;
  /** Appended to the callback origin. An empty path is the origin itself. */
  path: string;
}

export interface GuideField {
  name: string;
  label: string;
  kind: FieldKind;
  description?: string;
  /** Present when the value is a non-secret identifier the overview can echo back. */
  identifier?: string;
  /** Shown when the operator submits it empty. Unused for an optional field. */
  required: string;
  /** The app works without it; only the capability it unlocks is unavailable. */
  optional?: true;
}

/**
 * One job inside a provider's setup, with the steps that do it and the values it produces.
 * GitHub has two — repository access, then event triggers — because they have different
 * requirements and an operator on a plain-HTTP address can finish the first and not the second.
 */
export interface GuideGroup {
  id: string;
  /** Absent on the first group: the section header already names the job. */
  title?: string;
  description?: string;
  /** Set when the current origin cannot support this group. Steps and fields are then empty. */
  unavailable?: string;
  steps: readonly GuideStep[];
  fields: readonly GuideField[];
}

interface GuideGroupSource extends Omit<GuideGroup, "unavailable"> {
  /** Returns the reason this group cannot be set up here, or undefined when it can. */
  unavailableAt?: (origin: string) => string | undefined;
}

export interface ProviderGuide {
  provider: ProviderApplicationConfiguration["provider"];
  name: string;
  summary: string;
  portal: { label: string; href: string };
  groups: readonly GuideGroupSource[];
  urls: readonly GuideUrl[];
  /** Names the bounded panel the operator pastes into, after the portal they copied from. */
  formTitle: string;
  /** Row labels for the saved summary, in the vocabulary of that provider. */
  summaryLabels: { identity: string; owner?: string; connections: string };
  /** The exact names an operator has to change when the environment owns this app. */
  environmentVariables: readonly string[];
  /** Slack's save continues into Slack, so it has one action rather than verify-then-connect. */
  savingContinues: boolean;
  actions: {
    save: string;
    savePending: string;
    connect?: string;
    connectAgain?: string;
  };
  saveHint?: string;
  verifiedMessage?: string;
  /** Some providers cannot be set up without HTTPS; GitHub only loses inbound events. */
  requiresHttps: boolean;
  httpsRequirement: (origin: string) => string;
  /** Discord never posts to Hub, so it has no event line to wait on. */
  receivesEvents: boolean;
}

export function guideUrl(origin: string, path: string): string {
  return path === "" ? origin : `${origin}${path}`;
}
export function isSecureOrigin(origin: string): boolean {
  return origin.startsWith("https://");
}
export interface BrowserProviderModule {
  configuration: import("./configuration.js").ProviderConfigurationDefinition;
  resourceSchemas: {
    configuration: import("zod").ZodType<import("./resources.js").ProviderResourceView[]>;
    setup?: import("zod").ZodType<import("./resources.js").ProviderResourceView[]>;
  };
  connection: import("./connection-presentation.js").ProviderConnectionPresentation;
  failure: ProviderSetupFailure;
  setup: ProviderSetup;
  glyph: { viewBox: string; paths: readonly string[] };
  runHint: string;
  identityLabel(value: unknown): string;
  id: string;
  guide: ProviderGuide;
  request: {
    parse(
      input: unknown,
    ): import("../provider-applications/index.js").ProviderApplicationConfiguration & {
      surface?: "appSetup" | "apps" | undefined;
    };
    normalize(
      input: unknown,
    ): import("../provider-applications/index.js").ProviderApplicationConfiguration;
    secrets(input: unknown): readonly string[];
  };
}

export interface ProviderEventSummary {
  provider: string;
  headline: string;
  actor: string | null;
  externalUrl: string | null;
}

export function truncateEventText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export interface ProviderSetupInput {
  values: Readonly<Record<string, string>>;
  expectedVersion?: number;
  surface: ProviderApplicationSurface;
  variant?: string;
}
export interface ProviderSetupRetry {
  available(view: ProviderApplicationView): boolean;
  execute(): Promise<Result<void>>;
  successMessage: string;
}
export interface ProviderSetup {
  save: (input: ProviderSetupInput) => Promise<Result<ProviderApplicationSaveResult>>;
  summary(
    view: ProviderApplicationView,
    guide: ProviderGuide,
  ): readonly { label: string; value: string }[];
  eventState?(view: ProviderApplicationView, origin: string): string | undefined;
  showConnect?(view: ProviderApplicationView): boolean;
  retry?: ProviderSetupRetry;
  variants?: {
    label: string;
    choices: readonly { value: string; label: string; hint?: string }[];
    current(view: ProviderApplicationView): string;
    guide(value: string): ProviderGuide;
  };
}

export interface ProviderSetupFailure {
  host: string;
  applicationNoun: string;
  credentials(subject: string | undefined): string;
  special?(
    code: string | undefined,
    subject: string | undefined,
  ): { kind: FailureKind; message: string } | undefined;
  diagnostic?(error: unknown): Record<string, unknown> | undefined;
}
