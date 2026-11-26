import { createElement } from "react";
import {
  defineBrowserIntegration,
  type IntegrationSetupGuide,
  type IntegrationSetupVariant,
} from "../browser-contracts.js";
import {
  normalizeNotionToolGrant,
  notionDraftFromGrant,
  notionDraftToGrant,
  NotionToolGrantSchema,
  validateNotionToolDraft,
} from "./internal/contracts.js";

function NotionGlyph({ className }: { readonly className?: string }) {
  return createElement(
    "svg",
    {
      viewBox: "0 0 24 24",
      className: className ?? "size-4.5",
      fill: "currentColor",
      "aria-hidden": "true",
    },
    createElement("path", {
      d: "M4.46 4.21c.69.56.95.52 2.25.43l12.24-.73c.26 0 .04-.26-.04-.3l-2.04-1.47c-.6-.43-1.39-.95-2.9-.86L2.12 2.14c-.43.04-.52.26-.35.43l2.69 1.64Zm.73 2.86v12.88c0 .69.35.95 1.12.91l13.45-.78c.78-.04.87-.52.87-1.08V6.2c0-.56-.22-.86-.69-.82l-14.06.82c-.52.04-.69.3-.69.87Zm13.23.69c.09.39 0 .78-.39.82l-.65.13v9.51c-.56.3-1.08.48-1.51.48-.69 0-.87-.22-1.38-.86l-4.24-6.66v6.44l1.34.3s0 .78-1.08.78l-2.99.17c-.09-.17 0-.61.3-.69l.78-.22V9.32l-1.08-.09c-.09-.39.13-.95.74-.99l3.2-.22 4.42 6.75V8.81l-1.12-.13c-.09-.48.26-.82.69-.87l3.08-.05ZM1.34 1.1l12.16-.91c1.51-.13 1.9.09 2.86.78l3.94 2.77c.65.48.87.61.87 1.13v15.44c0 .95-.35 1.51-1.56 1.6l-14.32.86c-.91.04-1.34-.09-1.82-.69L.82 18.61C.26 17.87 0 17.31 0 16.4V2.7c0-1.12.35-1.51 1.34-1.6Z",
    }),
  );
}

const NOTION_INTERNAL_GUIDE: IntegrationSetupGuide = {
  provider: "notion",
  name: "Notion",
  summary: "Reads pages and data sources, updates properties, and comments on docs",
  portal: {
    label: "Create a Notion integration",
    href: "https://www.notion.so/profile/integrations/internal",
  },
  formTitle: "Paste from Notion",
  summaryLabels: {
    identity: "Workspace",
    connections: "Workspaces",
  },
  environmentVariables: ["NOTION_MODE", "NOTION_API_TOKEN"],
  urls: [],
  savingContinues: false,
  actions: {
    save: "Verify and save",
    savePending: "Verifying…",
  },
  verifiedMessage: "Notion accepted this connection",
  requiresHttps: false,
  httpsRequirement: (origin) => `Notion internal connections work from ${origin}`,
  receivesEvents: false,
  groups: [
    {
      id: "credentials",
      steps: [
        {
          segments: [
            { kind: "text", value: "Open " },
            {
              kind: "link",
              value: "Notion integrations",
              href: "https://www.notion.so/profile/integrations/internal",
            },
            { kind: "text", value: " and choose " },
            { kind: "term", value: "New integration" },
            { kind: "text", value: "." },
          ],
        },
        {
          segments: [
            { kind: "text", value: "Select " },
            { kind: "term", value: "Internal" },
            { kind: "text", value: ", pick your workspace, and turn on these capabilities:" },
          ],
          permissions: [
            { name: "Content", access: "Read, update, and insert" },
            { name: "Comments", access: "Read and insert" },
            { name: "User info", access: "Read without email" },
          ],
        },
        {
          segments: [
            { kind: "text", value: "Copy the " },
            { kind: "term", value: "Internal Integration Secret" },
            { kind: "text", value: " and share target pages or data sources via " },
            { kind: "term", value: "••• → Connections" },
            { kind: "text", value: "." },
          ],
        },
      ],
      fields: [
        {
          name: "apiToken",
          label: "Internal integration secret",
          kind: "secret",
          description: "Starts with ntn_ or secret_",
          required: "Enter the Internal integration secret",
        },
      ],
    },
  ],
};

const NOTION_OAUTH_GUIDE: IntegrationSetupGuide = {
  provider: "notion",
  name: "Notion",
  summary: "Reads pages and data sources, updates properties, and comments on docs",
  portal: {
    label: "Open Notion integrations",
    href: "https://www.notion.so/profile/integrations",
  },
  formTitle: "Paste from Notion",
  summaryLabels: {
    identity: "Integration",
    connections: "Workspaces",
  },
  environmentVariables: ["NOTION_MODE", "NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"],
  urls: [{ key: "redirect", label: "Redirect URI", path: "/api/integrations/notion/callback" }],
  savingContinues: true,
  actions: {
    save: "Save and continue to Notion",
    savePending: "Continuing to Notion…",
    connect: "Connect Notion",
    connectAgain: "Connect another workspace",
  },
  saveHint: "Notion asks a workspace member to authorize the integration before anything is saved",
  requiresHttps: true,
  httpsRequirement: (origin) =>
    `Notion OAuth needs HTTPS, and Hub is at ${origin}. Reopen Hub at its public HTTPS address to set up Notion`,
  receivesEvents: false,
  groups: [
    {
      id: "oauth",
      steps: [
        {
          segments: [
            { kind: "text", value: "Open " },
            {
              kind: "link",
              value: "Notion integrations",
              href: "https://www.notion.so/profile/integrations",
            },
            { kind: "text", value: ", create a " },
            { kind: "term", value: "Public" },
            { kind: "text", value: " integration, and add this " },
            { kind: "term", value: "Redirect URI" },
            { kind: "text", value: ":" },
          ],
          urls: ["redirect"],
        },
        {
          segments: [
            { kind: "text", value: "Under " },
            { kind: "term", value: "Capabilities" },
            { kind: "text", value: ", enable:" },
          ],
          permissions: [
            { name: "Content", access: "Read, update, and insert" },
            { name: "Comments", access: "Read and insert" },
            { name: "User info", access: "Read without email" },
          ],
        },
        {
          segments: [
            { kind: "text", value: "Copy the " },
            { kind: "term", value: "OAuth client ID" },
            { kind: "text", value: " and " },
            { kind: "term", value: "OAuth client secret" },
            { kind: "text", value: "." },
          ],
        },
      ],
      fields: [
        {
          name: "clientId",
          label: "OAuth client ID",
          kind: "text",
          identifier: "clientId",
          required: "Enter the OAuth client ID",
        },
        {
          name: "clientSecret",
          label: "OAuth client secret",
          kind: "secret",
          required: "Enter the OAuth client secret",
        },
      ],
    },
  ],
};

const NOTION_SETUP_VARIANTS: readonly IntegrationSetupVariant[] = [
  {
    id: "internal",
    label: "Internal connection",
    guide: NOTION_INTERNAL_GUIDE,
    buildConfiguration: (values) => ({
      provider: "notion",
      mode: "internal",
      apiToken: values["apiToken"] ?? "",
    }),
  },
  {
    id: "oauth",
    label: "Public OAuth",
    guide: NOTION_OAUTH_GUIDE,
    buildConfiguration: (values) => ({
      provider: "notion",
      mode: "oauth",
      clientId: values["clientId"] ?? "",
      clientSecret: values["clientSecret"] ?? "",
    }),
  },
];

export const notionBrowserIntegration = defineBrowserIntegration({
  id: "notion",
  label: "Notion",
  resourceNoun: "Data source",
  host: "api.notion.com",
  glyph: NotionGlyph,
  setup: {
    defaultVariantId: "internal",
    variants: NOTION_SETUP_VARIANTS,
    selectVariant: (identifiers) => (identifiers["mode"] === "oauth" ? "oauth" : "internal"),
    supportsOrgConnect: (identifiers) => identifiers["mode"] === "oauth",
  },
  tools: {
    grantSchema: NotionToolGrantSchema,
    normalizeGrant: normalizeNotionToolGrant,
    actions: [
      { id: "read", label: "Read pages and databases" },
      { id: "comment", label: "Post comments" },
      { id: "write", label: "Update pages" },
    ],
    fields: [
      {
        key: "data_sources",
        label: "Databases or data sources",
        placeholder: "248104cd-477e-80af-bc30-000bd28de8f9 or Notion URL",
        description: "Comma-separated IDs or Notion URLs",
      },
      {
        key: "pages",
        label: "Pages",
        placeholder: "153104cd-477e-809d-8dc4-ff2d96ae3090 or Notion URL",
        description: "Comma-separated IDs or Notion URLs, including child pages",
      },
    ],
    fromGrant: notionDraftFromGrant,
    toGrant: notionDraftToGrant,
    validateDraft: validateNotionToolDraft,
  },
});
