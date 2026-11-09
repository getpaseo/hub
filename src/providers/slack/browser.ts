import { type GuideStep, type ProviderGuide } from "../presentation.js";
import { normalizeRequest, requestSchema, requestSecrets } from "./application-configuration.js";
import { SLACK_REQUIRED_BOT_SCOPES } from "./client.js";
import { connectionPresentation } from "./connection-presentation.js";
import { failure } from "./failure.js";
import { createSetup, glyph, identityLabel, runHint } from "./presentation.js";
import { resourceSchemas } from "./public-resources.js";
function manifestFor(transport: "socket" | "webhook") {
  return {
    label: "App manifest",
    action: "Copy manifest",
    build: (origin: string) => slackManifest(origin, transport),
  };
}
export const SLACK_WEBHOOK_GUIDE: ProviderGuide = {
  provider: "slack",
  name: "Slack",
  summary: "Reads mentions in your workspace and replies in the thread.",
  portal: { label: "Create a Slack app", href: "https://api.slack.com/apps?new_app=1" },
  formTitle: "Paste from Slack",
  summaryLabels: { identity: "App ID", connections: "Workspaces" },
  environmentVariables: [
    "SLACK_APP_ID",
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "SLACK_SIGNING_SECRET",
  ],
  groups: [
    {
      id: "app",
      steps: [
        {
          segments: [
            { kind: "text", value: "Open " },
            {
              kind: "link",
              value: "Create a Slack app",
              href: "https://api.slack.com/apps?new_app=1",
            },
            { kind: "text", value: " and choose " },
            { kind: "term", value: "From a manifest" },
            { kind: "text", value: "." },
          ],
        },
        {
          segments: [{ kind: "text", value: "Pick your workspace, then paste this manifest:" }],
          manifest: manifestFor("webhook"),
        },
        { segments: [{ kind: "text", value: "Create the app." }] },
        {
          segments: [
            { kind: "text", value: "Open " },
            { kind: "term", value: "Basic Information → App Credentials" },
            { kind: "text", value: " and copy the four values." },
          ],
        },
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
    },
  ],
  urls: [
    { key: "redirect", label: "Redirect URL", path: "/api/integrations/slack/callback" },
    { key: "events", label: "Request URL", path: "/api/integrations/slack/events" },
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
  httpsRequirement: (origin) =>
    `Slack only works over HTTPS, and Hub is at ${origin}. Reopen Hub at its public HTTPS address to set up Slack.`,
  receivesEvents: true,
};

const slackStep = (value: string): GuideStep => ({
  segments: [{ kind: "text", value }],
});

export const SLACK_GUIDE: ProviderGuide = {
  provider: "slack",
  name: "Slack",
  summary: "Reads mentions in your workspace and replies in the thread.",
  portal: { label: "Create a Slack app", href: "https://api.slack.com/apps?new_app=1" },
  formTitle: "Connect Slack",
  summaryLabels: { identity: "App ID", connections: "Workspaces" },
  environmentVariables: ["SLACK_TRANSPORT", "SLACK_APP_ID", "SLACK_APP_TOKEN"],
  groups: [
    {
      id: "app",
      steps: [
        {
          segments: [
            { kind: "text", value: "Open " },
            {
              kind: "link",
              value: "Create a Slack app",
              href: "https://api.slack.com/apps?new_app=1",
            },
            { kind: "text", value: ", choose From a manifest, select the workspace, and paste:" },
          ],
          manifest: manifestFor("socket"),
        },
        slackStep(
          "Under Basic Information → App-Level Tokens, generate a token named Paseo with connections:write.",
        ),
        slackStep("Under OAuth & Permissions, install the app and copy the Bot User OAuth Token."),
      ],
      fields: [
        {
          name: "appToken",
          label: "App-level token",
          kind: "secret",
          description: "Starts with xapp-.",
          required: "Enter the App-level token.",
        },
        {
          name: "botToken",
          label: "Bot token",
          kind: "secret",
          description: "Starts with xoxb-.",
          required: "Enter the Bot token.",
        },
      ],
    },
  ],
  urls: [],
  savingContinues: false,
  actions: {
    save: "Connect Slack",
    savePending: "Checking Slack and connecting…",
  },
  verifiedMessage: "Slack connected.",
  requiresHttps: false,
  httpsRequirement: (origin) => `Slack can connect from ${origin}.`,
  receivesEvents: true,
};

export function slackManifest(origin: string, transport: "socket" | "webhook" = "socket"): string {
  const scopes = SLACK_REQUIRED_BOT_SCOPES.map((scope) => `      - ${scope}`).join("\n");
  const webhook =
    transport === "webhook"
      ? `  redirect_urls:\n    - ${origin}/api/integrations/slack/callback\n`
      : "";
  const requestUrl =
    transport === "webhook" ? `    request_url: ${origin}/api/integrations/slack/events\n` : "";
  return `display_information:
  name: Paseo
features:
  bot_user:
    display_name: Paseo
    always_online: false
oauth_config:
${webhook}  scopes:
    bot:
${scopes}
settings:
  event_subscriptions:
${requestUrl}    bot_events:
      - app_mention
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: ${transport === "socket" ? "true" : "false"}
  token_rotation_enabled: false
`;
}

export const slackBrowserProvider = {
  resourceSchemas,
  connection: connectionPresentation,
  failure,
  request: {
    parse: (input: unknown) => {
      const data = requestSchema.parse(input);
      return {
        ...normalizeRequest(data),
        ...(data.surface === undefined ? {} : { surface: data.surface }),
      };
    },
    normalize: (input: unknown) => normalizeRequest(requestSchema.parse(input)),
    secrets: (input: unknown) => requestSecrets(requestSchema.parse(input)),
  },
  setup: createSetup(SLACK_GUIDE, SLACK_WEBHOOK_GUIDE),
  glyph,
  runHint,
  identityLabel,
  id: "slack",
  guide: SLACK_GUIDE,
};
