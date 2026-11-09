import { z } from "zod";

export const deliveryStatusSchema = z.union([
  z.object({ state: z.enum(["connecting", "reconnecting", "connected", "stopped"]) }),
  z.object({
    state: z.literal("actionNeeded"),
    reason: z.enum(["appTokenRejected", "socketModeOff", "appIdentityMismatch"]),
  }),
]);
export type SlackDeliveryStatus = z.infer<typeof deliveryStatusSchema>;
const deliveryViewSchema = z.object({ deliveryStatus: deliveryStatusSchema.optional() });
export function readSlackDeliveryStatus(view: unknown): SlackDeliveryStatus | undefined {
  return deliveryViewSchema.parse(view).deliveryStatus;
}
