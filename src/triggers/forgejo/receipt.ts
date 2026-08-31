import { createHash } from "node:crypto";
import { logger } from "../../logger.js";
import type { Database } from "../../db/types.js";
import { isDatabaseUnavailableError } from "../../db/errors.js";
import { logProviderEventIntake } from "../audit.js";
import type { AcceptVerifiedForgejoDelivery, ForgejoVerifiedDelivery } from "./webhook.js";

export function hashForgejoBody(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function createForgejoReceiptAcceptance(options: {
  database: Database;
  onClaimed?: (input: { delivery: ForgejoVerifiedDelivery; receiptId: string }) => Promise<void>;
}): AcceptVerifiedForgejoDelivery {
  return async (delivery) => {
    const bodySha256 = hashForgejoBody(delivery.rawBody);
    try {
      const acceptance = await options.database.acceptForgejoEvent({
        organizationId: delivery.organizationId,
        connectionId: delivery.connectionId,
        repositoryId: delivery.repositoryId,
        deliveryId: delivery.deliveryId,
        signatureHash: delivery.signatureHash,
        source: `forgejo.${delivery.event}`,
        payload: forgejoReceiptPayload(delivery),
        receivedAt: delivery.receivedAt,
        provider: "forgejo",
        bodySha256,
      });
      logProviderEventIntake({
        provider: "forgejo",
        source: `forgejo.${delivery.event}`,
        deliveryId: delivery.deliveryId,
        resourceId: String(delivery.repositoryId),
        acceptance,
      });
      if (acceptance.status === "conflict") return { status: "conflict" };
      if (acceptance.status === "dropped") return { status: "unavailable" };
      if (acceptance.status === "accepted" && options.onClaimed !== undefined) {
        try {
          await options.onClaimed({ delivery, receiptId: acceptance.receiptId });
        } catch (error) {
          logger.warn(
            { err: error, deliveryId: delivery.deliveryId, receiptId: acceptance.receiptId },
            "forgejo claimed-delivery handoff failed after durable receipt",
          );
        }
      }
      if (acceptance.status === "accepted" || acceptance.status === "duplicate") {
        return { status: acceptance.status };
      }
      return { status: "unavailable" };
    } catch (error) {
      if (isDatabaseUnavailableError(error)) return { status: "unavailable" };
      throw error;
    }
  };
}

function forgejoReceiptPayload(delivery: ForgejoVerifiedDelivery): unknown {
  return {
    headers: {
      "x-forgejo-delivery": delivery.deliveryId,
      "x-forgejo-event": delivery.event,
      "x-forgejo-event-type": delivery.eventType,
    },
    raw: new TextDecoder("utf-8").decode(delivery.rawBody),
  };
}
