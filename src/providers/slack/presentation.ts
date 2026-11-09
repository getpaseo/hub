import type { ProviderApplicationView } from "../../provider-applications/index.js";
import type { ProviderGuide, ProviderSetup } from "../presentation.js";
import { saveProviderApplication } from "../setup.js";
import { identitySchema, slackSocketSchema } from "./application-configuration.js";
import { readSlackDeliveryStatus } from "./delivery.js";
export const glyph = {
  viewBox: "0 0 16 16",
  paths: [
    "M3.38 9.88A1.69 1.69 0 1 1 1.69 8.2h1.69v1.69Zm.85 0a1.69 1.69 0 1 1 3.38 0v4.23a1.69 1.69 0 1 1-3.38 0V9.88Zm1.69-6.76a1.69 1.69 0 1 1 1.69-1.69v1.69H5.92Zm0 .85a1.69 1.69 0 1 1 0 3.38H1.69a1.69 1.69 0 1 1 0-3.38h4.23Zm6.76 1.69a1.69 1.69 0 1 1 1.69 1.69h-1.69V5.66Zm-.85 0a1.69 1.69 0 1 1-3.38 0V1.43a1.69 1.69 0 1 1 3.38 0v4.23Zm-1.69 6.76a1.69 1.69 0 1 1-1.69 1.69v-1.69h1.69Zm0-.85a1.69 1.69 0 1 1 0-3.38h4.23a1.69 1.69 0 1 1 0 3.38h-4.23Z",
  ],
};
export const runHint = "Mention the bot in a channel it can see.";
export function identityLabel(value: unknown): string {
  const identity = identitySchema.parse(value);
  return identity.name;
}

export function createSetup(
  socketGuide: ProviderGuide,
  webhookGuide: ProviderGuide,
): ProviderSetup {
  return {
    async save(input) {
      if (input.variant === "webhook")
        return saveProviderApplication("slack", {
          ...input,
          values: { ...input.values, transport: "webhook" },
        });
      if (input.variant !== "socket") throw new Error(`unknown Slack transport: ${input.variant}`);
      const data = slackSocketSchema.parse({
        ...input.values,
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      });
      const { configureSlackSocketApplication } = await import("./functions.js");
      return configureSlackSocketApplication({ data });
    },
    summary(view, guide) {
      const rows: { label: string; value: string }[] = [];
      if (view.identity !== null) {
        const identity = identitySchema.parse(view.identity);
        rows.push({ label: guide.summaryLabels.identity, value: identity.id });
      }
      rows.push({
        label: "Delivery",
        value: view.identifiers["transport"] === "webhook" ? "Webhooks" : "Socket Mode",
      });
      return rows;
    },
    eventState(view) {
      if (view.identifiers["transport"] !== "socket") return undefined;
      return socketEventState(view);
    },
    showConnect: (view) => view.identifiers["transport"] !== "socket",
    retry: {
      available: (view) =>
        view.identifiers["transport"] === "socket" &&
        readSlackDeliveryStatus(view)?.state === "actionNeeded",
      successMessage: "Slack is reconnecting.",
      async execute() {
        const { retrySlackSocketDelivery } = await import("./functions.js");
        return retrySlackSocketDelivery();
      },
    },
    variants: {
      label: "How should Slack reach Hub?",
      choices: [
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
      ],
      current: (view) => (view.identifiers["transport"] === "webhook" ? "webhook" : "socket"),
      guide(value) {
        if (value === "socket") return socketGuide;
        if (value === "webhook") return webhookGuide;
        throw new Error(`unknown Slack transport: ${value}`);
      },
    },
  };
}
function socketEventState(view: ProviderApplicationView): string | undefined {
  const delivery = readSlackDeliveryStatus(view);
  if (delivery?.state === "connected") return "Connected";
  if (delivery?.state === "connecting" || delivery?.state === "reconnecting") return "Reconnecting";
  if (delivery?.state !== "actionNeeded") return undefined;
  return {
    socketModeOff: "Turn on Socket Mode in Slack, then retry",
    appIdentityMismatch: "Replace the app-level token with one from this Slack app",
    appTokenRejected: "Replace the app-level token",
  }[delivery.reason];
}
