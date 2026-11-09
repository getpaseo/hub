import { type ProviderGuide } from "../presentation.js";
import { normalizeRequest, requestSchema, requestSecrets } from "./application-configuration.js";
export const DISCORD_GUIDE: ProviderGuide = {
  provider: "discord",
  name: "Discord",
  summary: "Reads mentions in your server and replies in the thread.",
  portal: {
    label: "Open the Discord developer portal",
    href: "https://discord.com/developers/applications",
  },
  formTitle: "Paste from Discord",
  summaryLabels: { identity: "Application", connections: "Servers" },
  environmentVariables: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN"],
  groups: [
    {
      id: "application",
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
            { kind: "term", value: "General Information" },
            { kind: "text", value: " and copy the " },
            { kind: "term", value: "Application ID" },
            { kind: "text", value: "." },
          ],
        },
        {
          segments: [
            { kind: "text", value: "Open " },
            { kind: "term", value: "OAuth2" },
            { kind: "text", value: ", copy the " },
            { kind: "term", value: "Client Secret" },
            { kind: "text", value: ", and add this " },
            { kind: "term", value: "Redirect" },
            { kind: "text", value: ":" },
          ],
          urls: ["redirect"],
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
            { kind: "text", value: "Under " },
            { kind: "term", value: "Bot → Privileged Gateway Intents" },
            { kind: "text", value: ", turn on " },
            { kind: "term", value: "Message Content Intent" },
            { kind: "text", value: ". Without it the bot only receives empty messages." },
          ],
        },
      ],
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
    },
  ],
  urls: [{ key: "redirect", label: "Redirect", path: "/api/integrations/discord/callback" }],
  savingContinues: false,
  actions: {
    save: "Verify and save",
    savePending: "Verifying…",
    connect: "Add to a Discord server",
    connectAgain: "Add to another server",
  },
  verifiedMessage: "Discord accepted this application.",
  requiresHttps: false,
  httpsRequirement: (origin) => `Discord is set up the same way at ${origin}.`,
  receivesEvents: false,
};

export const discordBrowserProvider = {
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
  id: "discord",
  guide: DISCORD_GUIDE,
};
