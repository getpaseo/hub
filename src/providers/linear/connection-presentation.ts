import { z } from "zod";
import {
  connected,
  disconnected,
  cancelled,
  type ProviderConnectionPresentation,
} from "../connection-presentation.js";
const statusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("requiresReauthorization") }),
  z.object({ status: z.literal("connected") }),
]);
const connectionSchema = z.object({
  id: z.string(),
  slug: z.string(),
  linearOrganizationId: z.string(),
  requiresReauthorization: z.boolean(),
});
export const connectionPresentation: ProviderConnectionPresentation = {
  order: 3,
  parseStatus: (value) => statusSchema.parse(value),
  rows(value) {
    return connectionSchema
      .array()
      .parse(value)
      .map((connection) => ({
        provider: "linear" as const,
        id: connection.id,
        name: connection.slug,
        externalId: `workspace ${connection.linearOrganizationId}`,
        status: connection.requiresReauthorization
          ? ("requiresReauthorization" as const)
          : ("connected" as const),
      }));
  },
  actionLabel(status, _rows) {
    return status.status === "requiresReauthorization" ? "Reauthorize" : "Connect";
  },
  returns: {
    linear_connected: connected,
    linear_disconnected: disconnected,
    linear_cancelled: (name) => cancelled("Authorization", name),
  },
};
