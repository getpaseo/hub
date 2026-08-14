import { SLACK_REQUIRED_BOT_SCOPES } from "../providers/slack/client.js";
import type { Provider, ProviderApplicationIdentity, ProviderApplicationStatus } from "./index.js";

/**
 * Presentation unions spelled here rather than imported from the components, so this module stays
 * free of JSX and buildable by the server project. Divergence from `ApplicationField` or
 * `StatusPill` fails where a guide is handed to them, which is the only place it could matter.
 */
type FieldKind = "text" | "secret" | "multiline";
type Tone = "success" | "warning" | "danger" | "neutral";

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
  manifest?: boolean;
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
  /** Shown when the operator submits it empty. */
  required: string;
}

export interface ProviderGuide {
  provider: Provider;
  name: string;
  summary: string;
  portal: { label: string; href: string };
  steps: readonly GuideStep[];
  note?: string;
  urls: readonly GuideUrl[];
  fields: readonly GuideField[];
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
  /** Slack cannot be set up at all without HTTPS; the others only lose inbound events. */
  requiresHttps: boolean;
  insecureOriginNotice: (origin: string) => { tone: "warning" | "default"; message: string };
  /** Discord never posts to Hub, so it has no event line to wait on. */
  receivesEvents: boolean;
}

export const GITHUB_GUIDE: ProviderGuide = {
  provider: "github",
  name: "GitHub",
  summary: "Reads issues and pull requests, and lets agents push.",
  portal: { label: "Create a GitHub App", href: "https://github.com/settings/apps/new" },
  steps: [
    {
      segments: [
        { kind: "text", value: "Open " },
        {
          kind: "link",
          value: "Create a GitHub App",
          href: "https://github.com/settings/apps/new",
        },
        { kind: "text", value: " and give it a name." },
      ],
    },
    {
      segments: [{ kind: "text", value: "Set these URLs:" }],
      urls: ["homepage", "callback", "setup", "webhook"],
    },
    {
      segments: [
        { kind: "text", value: "Turn on " },
        { kind: "term", value: "Redirect on update" },
        { kind: "text", value: " and " },
        { kind: "term", value: "Active" },
        { kind: "text", value: " under Webhook, then set a " },
        { kind: "term", value: "Webhook secret" },
        { kind: "text", value: " you generate." },
      ],
    },
    {
      segments: [
        { kind: "text", value: "Under " },
        { kind: "term", value: "Repository permissions" },
        {
          kind: "text",
          value:
            " set Contents to Read and write, Issues to Read and write, Pull requests to Read and write, and Metadata to Read-only.",
        },
      ],
    },
    {
      segments: [
        { kind: "text", value: "Under " },
        { kind: "term", value: "Subscribe to events" },
        {
          kind: "text",
          value:
            " select Issue comment, Issues, Pull request review, Pull request review comment, and Push.",
        },
      ],
    },
    {
      segments: [
        { kind: "text", value: "Create the App, then generate a client secret and a private key." },
      ],
    },
    { segments: [{ kind: "text", value: "Paste the values below." }] },
  ],
  note: "To let an organization own the App, start from that organization's Developer settings instead.",
  urls: [
    { key: "homepage", label: "Homepage URL", path: "" },
    { key: "callback", label: "Callback URL", path: "/api/integrations/github/callback" },
    { key: "setup", label: "Setup URL", path: "/api/integrations/github/setup" },
    { key: "webhook", label: "Webhook URL", path: "/webhook" },
  ],
  fields: [
    {
      name: "appId",
      label: "App ID",
      kind: "text",
      identifier: "appId",
      required: "Enter the App ID.",
    },
    {
      name: "appSlug",
      label: "App slug",
      kind: "text",
      description: "The last part of the App's public link: github.com/apps/your-app",
      identifier: "appSlug",
      required: "Enter the App slug.",
    },
    {
      name: "clientId",
      label: "Client ID",
      kind: "text",
      identifier: "clientId",
      required: "Enter the Client ID.",
    },
    {
      name: "clientSecret",
      label: "Client secret",
      kind: "secret",
      required: "Enter the Client secret.",
    },
    {
      name: "privateKey",
      label: "Private key",
      kind: "multiline",
      description: "Paste the contents of the .pem file you downloaded.",
      required: "Enter the Private key.",
    },
    {
      name: "webhookSecret",
      label: "Webhook secret",
      kind: "secret",
      required: "Enter the Webhook secret.",
    },
  ],
  savingContinues: false,
  actions: {
    save: "Verify and save",
    savePending: "Verifying…",
    connect: "Install on GitHub",
    connectAgain: "Add another installation",
  },
  verifiedMessage: "GitHub accepted this App.",
  requiresHttps: false,
  insecureOriginNotice: (origin) => ({
    tone: "warning",
    message: `GitHub delivers events to the webhook URL, so it has to be reachable from the internet. This Hub is at ${origin}.`,
  }),
  receivesEvents: true,
};

export const SLACK_GUIDE: ProviderGuide = {
  provider: "slack",
  name: "Slack",
  summary: "Reads mentions in your workspace and replies in the thread.",
  portal: { label: "Create a Slack app", href: "https://api.slack.com/apps?new_app=1" },
  steps: [
    {
      segments: [
        { kind: "text", value: "Open " },
        { kind: "link", value: "Create a Slack app", href: "https://api.slack.com/apps?new_app=1" },
        { kind: "text", value: " and choose " },
        { kind: "term", value: "From a manifest" },
        { kind: "text", value: "." },
      ],
    },
    {
      segments: [{ kind: "text", value: "Pick your workspace, then paste this manifest:" }],
      manifest: true,
    },
    { segments: [{ kind: "text", value: "Create the app." }] },
    {
      segments: [
        { kind: "text", value: "From " },
        { kind: "term", value: "Basic Information → App Credentials" },
        { kind: "text", value: ", paste the values below." },
      ],
    },
    {
      segments: [
        {
          kind: "text",
          value:
            "Choose Save and continue to Slack. Slack asks you to install the app in your workspace.",
        },
      ],
    },
  ],
  urls: [
    { key: "redirect", label: "Redirect URL", path: "/api/integrations/slack/callback" },
    { key: "events", label: "Request URL", path: "/api/integrations/slack/events" },
  ],
  fields: [
    {
      name: "appId",
      label: "App ID",
      kind: "text",
      identifier: "appId",
      required: "Enter the App ID.",
    },
    {
      name: "clientId",
      label: "Client ID",
      kind: "text",
      identifier: "clientId",
      required: "Enter the Client ID.",
    },
    {
      name: "clientSecret",
      label: "Client Secret",
      kind: "secret",
      required: "Enter the Client Secret.",
    },
    {
      name: "signingSecret",
      label: "Signing Secret",
      kind: "secret",
      required: "Enter the Signing Secret.",
    },
  ],
  savingContinues: true,
  actions: {
    save: "Save and continue to Slack",
    savePending: "Continuing to Slack…",
    connect: "Add to a Slack workspace",
    connectAgain: "Add another workspace",
  },
  saveHint: "Slack asks you to install the app before anything is saved.",
  requiresHttps: true,
  insecureOriginNotice: () => ({
    tone: "warning",
    message: "Slack requires Hub to use HTTPS before you can set it up.",
  }),
  receivesEvents: true,
};

export const DISCORD_GUIDE: ProviderGuide = {
  provider: "discord",
  name: "Discord",
  summary: "Reads mentions in your server and replies in the thread.",
  portal: {
    label: "Open the Discord developer portal",
    href: "https://discord.com/developers/applications",
  },
  steps: [
    {
      segments: [
        { kind: "text", value: "Open the " },
        {
          kind: "link",
          value: "Discord developer portal",
          href: "https://discord.com/developers/applications",
        },
        { kind: "text", value: ", choose " },
        { kind: "term", value: "New Application" },
        { kind: "text", value: ", and give it a name." },
      ],
    },
    {
      segments: [
        { kind: "text", value: "Open " },
        { kind: "term", value: "Bot" },
        { kind: "text", value: ", choose " },
        { kind: "term", value: "Reset Token" },
        { kind: "text", value: ", and copy the token." },
      ],
    },
    {
      segments: [
        { kind: "text", value: "On the same page turn on " },
        { kind: "term", value: "Message Content Intent" },
        { kind: "text", value: ". Without it the bot receives empty messages." },
      ],
    },
    {
      segments: [
        { kind: "text", value: "Open " },
        { kind: "term", value: "OAuth2" },
        { kind: "text", value: " and add this " },
        { kind: "term", value: "Redirect" },
        { kind: "text", value: ":" },
      ],
      urls: ["redirect"],
    },
    { segments: [{ kind: "text", value: "Paste the values below." }] },
  ],
  urls: [{ key: "redirect", label: "Redirect", path: "/api/integrations/discord/callback" }],
  fields: [
    {
      name: "applicationId",
      label: "Application ID",
      kind: "text",
      description: "From General Information.",
      identifier: "applicationId",
      required: "Enter the Application ID.",
    },
    {
      name: "clientSecret",
      label: "Client Secret",
      kind: "secret",
      description: "From OAuth2.",
      required: "Enter the Client Secret.",
    },
    {
      name: "botToken",
      label: "Bot token",
      kind: "secret",
      description: "From Bot → Reset Token.",
      required: "Enter the Bot token.",
    },
  ],
  savingContinues: false,
  actions: {
    save: "Verify and save",
    savePending: "Verifying…",
    connect: "Add to a Discord server",
    connectAgain: "Add to another server",
  },
  verifiedMessage: "Discord accepted this application.",
  requiresHttps: false,
  insecureOriginNotice: () => ({
    tone: "default",
    message: "Discord doesn't call this Hub, so a local address is fine here.",
  }),
  receivesEvents: false,
};

export const PROVIDER_GUIDES: readonly ProviderGuide[] = [GITHUB_GUIDE, SLACK_GUIDE, DISCORD_GUIDE];

export function guideFor(provider: Provider): ProviderGuide {
  const guide = PROVIDER_GUIDES.find((candidate) => candidate.provider === provider);
  if (guide === undefined) throw new Error(`unknown provider: ${provider}`);
  return guide;
}

export function guideUrl(origin: string, path: string): string {
  return path === "" ? origin : `${origin}${path}`;
}

/**
 * The manifest Slack reads. Scopes come from the same constant the running Slack integration
 * checks installations against, so a manifest the operator pastes can never ask for less than
 * Hub needs.
 */
export function slackManifest(origin: string): string {
  const scopes = SLACK_REQUIRED_BOT_SCOPES.map((scope) => `      - ${scope}`).join("\n");
  return `display_information:
  name: Paseo
features:
  bot_user:
    display_name: Paseo
    always_online: false
oauth_config:
  redirect_urls:
    - ${origin}/api/integrations/slack/callback
  scopes:
    bot:
${scopes}
settings:
  event_subscriptions:
    request_url: ${origin}/api/integrations/slack/events
    bot_events:
      - app_mention
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;
}

const STATUS_LABELS: Record<ProviderApplicationStatus, { label: string; tone: Tone }> = {
  notConfigured: { label: "Not set up", tone: "neutral" },
  // Neutral on purpose. Credentials a provider accepted are not a working integration, and the
  // success tone is reserved for a connection that actually exists.
  verified: { label: "Verified", tone: "neutral" },
  connected: { label: "Connected", tone: "success" },
  actionNeeded: { label: "Action needed", tone: "warning" },
  managedByEnvironment: { label: "Managed by environment", tone: "neutral" },
};

export function statusPresentation(status: ProviderApplicationStatus): {
  label: string;
  tone: Tone;
} {
  return STATUS_LABELS[status];
}

export function identityLabel(identity: ProviderApplicationIdentity): string {
  if (identity.provider === "github") return `${identity.name} · owned by ${identity.ownerLogin}`;
  if (identity.provider === "discord") return `${identity.name} · application ${identity.id}`;
  return identity.name;
}

export function isSecureOrigin(origin: string): boolean {
  return origin.startsWith("https://");
}
