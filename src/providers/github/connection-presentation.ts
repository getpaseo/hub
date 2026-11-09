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
  z.object({
    status: z.enum(["connected", "suspended"]),
  }),
]);
const connectionSchema = z.object({
  id: z.string(),
  slug: z.string(),
  accountLogin: z.string(),
  installationId: z.number(),
  status: z.enum(["active", "suspended"]),
});
export const connectionPresentation: ProviderConnectionPresentation = {
  order: 0,
  parseStatus: (value) => statusSchema.parse(value),
  rows(value) {
    return connectionSchema
      .array()
      .parse(value)
      .map((connection) => ({
        provider: "github" as const,
        id: connection.id,
        name: connection.slug,
        externalId: `${connection.accountLogin} · installation ${connection.installationId}`,
        status: connection.status,
      }));
  },
  actionLabel(_status, rows) {
    return rows.some((row) => row.status === "suspended") ? "Reconnect" : "Connect";
  },
  returns: {
    github_connected: connected,
    github_disconnected: disconnected,
    github_cancelled: (name) => cancelled("Installation", name),
    github_approval_required: (name) =>
      failed(
        name,
        "A GitHub organization owner has to approve this installation. Nothing was connected. Ask an owner to approve the request, then install again.",
      ),
  },
};
