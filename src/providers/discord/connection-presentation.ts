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
  z.object({
    status: z.literal("connected"),
  }),
]);
const connectionSchema = z.object({ id: z.string(), slug: z.string(), guildId: z.string() });
export const connectionPresentation: ProviderConnectionPresentation = {
  order: 1,
  parseStatus: (value) => statusSchema.parse(value),
  rows(value) {
    return connectionSchema
      .array()
      .parse(value)
      .map((connection) => ({
        provider: "discord" as const,
        id: connection.id,
        name: connection.slug,
        externalId: `guild ${connection.guildId}`,
        status: "connected" as const,
      }));
  },
  returns: {
    discord_connected: connected,
    discord_disconnected: disconnected,
    discord_cancelled: (name) => cancelled("Authorization", name),
  },
};
