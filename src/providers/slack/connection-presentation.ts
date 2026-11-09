import { z } from "zod";
import {
  connected,
  disconnected,
  cancelled,
  failed,
  type ProviderConnectionPresentation,
} from "../connection-presentation.js";
const statusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("requiresReauthorization") }),
  z.object({
    status: z.literal("connected"),
  }),
]);
const connectionSchema = z.object({
  id: z.string(),
  slug: z.string(),
  teamId: z.string(),
  requiresReauthorization: z.boolean(),
});
export const connectionPresentation: ProviderConnectionPresentation = {
  order: 2,
  parseStatus: (value) => statusSchema.parse(value),
  rows(value) {
    return connectionSchema
      .array()
      .parse(value)
      .map((connection) => ({
        provider: "slack" as const,
        id: connection.id,
        name: connection.slug,
        externalId: `workspace ${connection.teamId}`,
        status: connection.requiresReauthorization
          ? ("requiresReauthorization" as const)
          : ("connected" as const),
      }));
  },
  actionLabel(status, _rows) {
    return status.status === "requiresReauthorization" ? "Reauthorize" : "Connect";
  },
  returns: {
    slack_connected: connected,
    slack_disconnected: disconnected,
    slack_cancelled: (name) => cancelled("Installation", name),
    slack_bot_failed: (name) =>
      failed(
        name,
        "Slack installed the app without every permission Hub needs. Nothing was saved. Reapply the manifest under Features → OAuth & Permissions, then install again.",
      ),
  },
};
