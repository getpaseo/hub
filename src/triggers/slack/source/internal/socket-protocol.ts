import { z } from "zod";

const SlackId = z.string().min(1).max(255);

export const SlackSocketHelloSchema = z
  .object({
    type: z.literal("hello"),
    connection_info: z.object({ app_id: SlackId }),
    num_connections: z.number().int().positive().optional(),
  })
  .passthrough();

export const SlackSocketDisconnectSchema = z
  .object({
    type: z.literal("disconnect"),
    reason: z.enum(["warning", "refresh_requested", "link_disabled"]),
  })
  .passthrough();

export const SlackSocketEnvelopeSchema = z
  .object({
    type: z.string().min(1).max(255),
    envelope_id: SlackId,
    payload: z.unknown(),
    accepts_response_payload: z.boolean().optional(),
  })
  .passthrough();

export type SlackSocketEnvelope = z.infer<typeof SlackSocketEnvelopeSchema>;

export const SlackSocketOpenResponseSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().max(255).optional(),
    url: z.string().url().optional(),
  })
  .passthrough();

export function slackSocketAck(envelopeId: string): string {
  return JSON.stringify({ envelope_id: envelopeId });
}
