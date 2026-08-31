import type { Database } from "../../db/types.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import type { NormalizedForgejoEvent } from "./normalize.js";
import type { ForgejoWorkflowRunConsumer } from "./dispatch.js";
import { registerForgejoWorkflowRunConsumer } from "./dispatch.js";
import type { ForgejoVerifiedDelivery } from "./webhook.js";

export interface ForgejoPushDispatchTarget {
  projectId: string;
  organizationId: string;
  configurationRevisionId: string;
  connectionId: string;
  resourceId: string | null;
}

export function createForgejoPushConsumer(options: {
  enqueue: TriggerHandler;
  listTargets: (input: {
    organizationId: string;
    connectionId: string;
    repositoryId: number;
  }) => Promise<readonly ForgejoPushDispatchTarget[]>;
}): ForgejoWorkflowRunConsumer {
  return {
    async consume(input) {
      if (input.event.rawFamily !== "forgejo.push") return;
      if (input.event.context.actor.login.length === 0) {
        throw new Error("forgejo_push_sender_missing");
      }
      const targets = await options.listTargets({
        organizationId: input.delivery.organizationId,
        connectionId: input.event.context.connectionId,
        repositoryId: input.event.context.repository.id,
      });
      await Promise.all(
        targets.map((target) =>
          options.enqueue(pushTrigger(input.receiptId, input.delivery, input.event, target)),
        ),
      );
    },
  };
}

export function createForgejoPushSource(options: { database: Database }): TriggerSource {
  return {
    async start(handler: TriggerHandler) {
      registerForgejoWorkflowRunConsumer(
        createForgejoPushConsumer({
          enqueue: handler,
          listTargets: (input) =>
            options.database.listActiveTriggerDispatchTargets({
              organizationId: input.organizationId,
              provider: "forgejo",
              connectionId: input.connectionId,
              resourceId: String(input.repositoryId),
            }),
        }),
      );
    },
    async stop() {
      return;
    },
  };
}

export function forgejoPushHasReactionSubject(): false {
  return false;
}

function pushTrigger(
  receiptId: string,
  delivery: ForgejoVerifiedDelivery,
  _event: NormalizedForgejoEvent,
  target: ForgejoPushDispatchTarget,
) {
  return {
    providerEventReceiptId: receiptId,
    organizationId: target.organizationId,
    projectId: target.projectId,
    configurationRevisionId: target.configurationRevisionId,
    source: "forgejo.push" as const,
    deliveryId: delivery.deliveryId,
    receivedAt: delivery.receivedAt,
    payload: {
      headers: {
        "x-forgejo-delivery": delivery.deliveryId,
        "x-forgejo-event": delivery.event,
        "x-forgejo-event-type": delivery.eventType,
      },
      raw: new TextDecoder("utf-8").decode(delivery.rawBody),
    },
    connectionId: target.connectionId,
    resourceId: target.resourceId,
  };
}
