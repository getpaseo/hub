import { failure } from "./failure.js";
import { setup } from "./presentation.js";
import { glyph, runHint, identityLabel } from "./presentation.js";
import { isSecureOrigin, type ProviderGuide } from "../presentation.js";
import { normalizeRequest, requestSchema, requestSecrets } from "./application-configuration.js";
export const GITHUB_GUIDE: ProviderGuide = {
  provider: "github",
  name: "GitHub",
  summary: "Reads issues and pull requests, and lets agents push.",
  portal: { label: "Create a GitHub App", href: "https://github.com/settings/apps/new" },
  formTitle: "Paste from GitHub",
  summaryLabels: { identity: "App", owner: "Owner", connections: "Installations" },
  environmentVariables: [
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
  ],
  groups: [
    {
      id: "access",
      steps: [
        {
          segments: [
            {
              kind: "text",
              value:
                "Decide who owns the App. To let an organization own it, start from that organization's ",
            },
            { kind: "term", value: "Developer settings" },
            { kind: "text", value: ". Otherwise it belongs to your account." },
          ],
        },
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
          segments: [
            { kind: "text", value: "Set these URLs, and turn on " },
            { kind: "term", value: "Redirect on update" },
            { kind: "text", value: " under " },
            { kind: "term", value: "Setup URL" },
            { kind: "text", value: ":" },
          ],
          urls: ["homepage", "callback", "setup"],
        },
        {
          segments: [
            { kind: "text", value: "Under " },
            { kind: "term", value: "Repository permissions" },
            { kind: "text", value: ", grant:" },
          ],
          permissions: [
            { name: "Contents", access: "Read and write" },
            { name: "Issues", access: "Read and write" },
            { name: "Pull requests", access: "Read and write" },
            { name: "Metadata", access: "Read-only" },
          ],
        },
        {
          segments: [
            { kind: "text", value: "Under " },
            { kind: "term", value: "Organization permissions" },
            {
              kind: "text",
              value:
                ", grant Members read-only access so Hub can verify that the person connecting an organization installation is an organization admin. For an existing App, approve this permission on the installation before reconnecting.",
            },
          ],
          permissions: [{ name: "Members", access: "Read-only" }],
        },
        {
          segments: [
            { kind: "text", value: "Create the App, then generate a " },
            { kind: "term", value: "Client secret" },
            { kind: "text", value: " and a " },
            { kind: "term", value: "Private key" },
            { kind: "text", value: "." },
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
      ],
    },
    {
      id: "events",
      title: "Event triggers",
      description:
        "Start workflows from GitHub issues, comments, and pushes. Repository access works without this.",
      unavailableAt: (origin) =>
        isSecureOrigin(origin)
          ? undefined
          : `GitHub delivers events to a webhook URL, so this part needs a public HTTPS address. Hub is at ${origin}. Repository access works now; reopen Hub at its HTTPS address to add event triggers.`,
      steps: [
        {
          segments: [
            { kind: "text", value: "In the App's settings, under " },
            { kind: "term", value: "Webhook" },
            { kind: "text", value: ", turn on " },
            { kind: "term", value: "Active" },
            { kind: "text", value: " and set the " },
            { kind: "term", value: "Webhook URL" },
            { kind: "text", value: ":" },
          ],
          urls: ["webhook"],
        },
        {
          segments: [
            { kind: "text", value: "Set a " },
            { kind: "term", value: "Webhook secret" },
            { kind: "text", value: " you generate." },
          ],
        },
        {
          segments: [
            { kind: "text", value: "Under " },
            { kind: "term", value: "Subscribe to events" },
            { kind: "text", value: ", select:" },
          ],
          events: [
            "Issue comment",
            "Issues",
            "Pull requests",
            "Pull request review",
            "Pull request review comment",
            "Push",
          ],
        },
      ],
      fields: [
        {
          name: "webhookSecret",
          label: "Webhook secret",
          kind: "secret",
          description: "Until this is set, GitHub events are rejected and no trigger fires.",
          required: "Enter the Webhook secret.",
          optional: true,
        },
      ],
    },
  ],
  urls: [
    { key: "homepage", label: "Homepage URL", path: "" },
    { key: "callback", label: "Callback URL", path: "/api/integrations/github/callback" },
    { key: "setup", label: "Setup URL", path: "/api/integrations/github/setup" },
    { key: "webhook", label: "Webhook URL", path: "/webhook" },
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
  httpsRequirement: (origin) =>
    `GitHub event triggers need a public HTTPS address, and Hub is at ${origin}.`,
  receivesEvents: true,
};

export const githubBrowserProvider = {
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
  setup,
  glyph,
  runHint,
  identityLabel,
  id: "github",
  guide: GITHUB_GUIDE,
};
