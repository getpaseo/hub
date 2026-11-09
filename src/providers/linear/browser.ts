import { failure } from "./failure.js";
import { setup } from "./presentation.js";
import { glyph, runHint, identityLabel } from "./presentation.js";
import { type ProviderGuide } from "../presentation.js";
import { normalizeRequest, requestSchema, requestSecrets } from "./application-configuration.js";
export const LINEAR_GUIDE: ProviderGuide = {
  provider: "linear",
  name: "Linear",
  summary: "Starts project-scoped workflows from issues and posts outcomes back to Linear.",
  portal: {
    label: "Open Linear API applications",
    href: "https://linear.app/settings/api/applications",
  },
  formTitle: "Paste from Linear",
  summaryLabels: { identity: "Application", connections: "Workspaces" },
  environmentVariables: ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET"],
  groups: [
    {
      id: "application",
      steps: [
        {
          segments: [
            { kind: "text", value: "Open " },
            {
              kind: "link",
              value: "Linear API applications",
              href: "https://linear.app/settings/api/applications",
            },
            { kind: "text", value: ", create an application, and give it a name." },
          ],
        },
        {
          segments: [
            { kind: "text", value: "Add this " },
            { kind: "term", value: "Redirect URL" },
            { kind: "text", value: " to the application's OAuth settings:" },
          ],
          urls: ["redirect"],
        },
        {
          segments: [
            { kind: "text", value: "Create Issue and Comment webhooks using this " },
            { kind: "term", value: "Webhook URL" },
            { kind: "text", value: " and a signing secret you will paste below:" },
          ],
          urls: ["events"],
          events: ["Issue", "Comment"],
        },
        {
          segments: [
            { kind: "text", value: "Copy the application's " },
            { kind: "term", value: "Client ID" },
            { kind: "text", value: ", " },
            { kind: "term", value: "Client Secret" },
            { kind: "text", value: ", and webhook signing secret." },
          ],
        },
      ],
      fields: [
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
          name: "webhookSecret",
          label: "Webhook signing secret",
          kind: "secret",
          required: "Enter the webhook signing secret.",
        },
      ],
    },
  ],
  urls: [
    { key: "redirect", label: "Redirect URL", path: "/api/integrations/linear/callback" },
    { key: "events", label: "Webhook URL", path: "/api/integrations/linear/events" },
  ],
  savingContinues: true,
  actions: {
    save: "Save and continue to Linear",
    savePending: "Continuing to Linear…",
    connect: "Connect a Linear workspace",
    connectAgain: "Connect another workspace",
  },
  saveHint: "Linear asks an administrator to authorize the app before anything is saved.",
  requiresHttps: true,
  httpsRequirement: (origin) =>
    `Linear webhooks need HTTPS, and Hub is at ${origin}. Reopen Hub at its public HTTPS address to set up Linear.`,
  receivesEvents: true,
};

export const linearBrowserProvider = {
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
  id: "linear",
  guide: LINEAR_GUIDE,
};
