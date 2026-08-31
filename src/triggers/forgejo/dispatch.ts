import { logger } from "../../logger.js";
import type { ForgejoVerifiedDelivery } from "./webhook.js";
import {
  isForgejoDefaultBranchPush,
  normalizeForgejoDelivery,
  type ForgejoConnectionContext,
  type ForgejoNormalizedResult,
  type ForgejoReconciliationSignal,
  type NormalizedForgejoEvent,
} from "./normalize.js";

export type ForgejoConsumerStatus = "succeeded" | "failed" | "skipped" | "unregistered";

export interface ForgejoConsumerObservation {
  status: ForgejoConsumerStatus;
  error?: string;
}

export interface ForgejoDispatchObservation {
  result: ForgejoNormalizedResult;
  workflow: ForgejoConsumerObservation;
  configSync: ForgejoConsumerObservation;
  hydration: ForgejoConsumerObservation;
}

export interface ForgejoWorkflowRunConsumer {
  consume(input: {
    receiptId: string;
    delivery: ForgejoVerifiedDelivery;
    event: NormalizedForgejoEvent;
  }): Promise<void>;
}

export interface ForgejoConfigSyncConsumer {
  consume(input: {
    receiptId: string;
    delivery: ForgejoVerifiedDelivery;
    event: NormalizedForgejoEvent;
  }): Promise<void>;
}

export interface ForgejoHydrationConsumer {
  consume(input: {
    receiptId: string;
    delivery: ForgejoVerifiedDelivery;
    signal: ForgejoReconciliationSignal;
  }): Promise<void>;
}

export interface ForgejoConsumerRegistry {
  workflow?: ForgejoWorkflowRunConsumer | readonly ForgejoWorkflowRunConsumer[];
  configSync?: ForgejoConfigSyncConsumer;
  hydration?: ForgejoHydrationConsumer;
}

const workflowConsumers: ForgejoWorkflowRunConsumer[] = [];
const registry: ForgejoConsumerRegistry = {};

export function registerForgejoWorkflowRunConsumer(consumer: ForgejoWorkflowRunConsumer): void {
  workflowConsumers.push(consumer);
}

export function registerForgejoConfigSyncConsumer(consumer: ForgejoConfigSyncConsumer): void {
  registry.configSync = consumer;
}

export function registerForgejoHydrationConsumer(consumer: ForgejoHydrationConsumer): void {
  registry.hydration = consumer;
}

export function forgejoConsumerRegistry(): Readonly<ForgejoConsumerRegistry> {
  return registry;
}

export function createForgejoClaimedHandoff(options: {
  connectionFor: (connectionId: string) => Promise<ForgejoConnectionContext | undefined>;
  consumers?: ForgejoConsumerRegistry;
}): (input: { delivery: ForgejoVerifiedDelivery; receiptId: string }) => Promise<void> {
  return async (input) => {
    const connection = await options.connectionFor(input.delivery.connectionId);
    if (connection === undefined) {
      logger.warn(
        { connectionId: input.delivery.connectionId, receiptId: input.receiptId },
        "forgejo claimed delivery has no connection context",
      );
      return;
    }
    const observation = await dispatchForgejoClaimed({
      delivery: input.delivery,
      receiptId: input.receiptId,
      connection,
      consumers: options.consumers ?? registry,
    });
    const failed = [observation.workflow, observation.configSync, observation.hydration].find(
      (entry) => entry.status === "failed",
    );
    if (failed !== undefined) {
      throw new Error(failed.error ?? "forgejo_consumer_failed");
    }
  };
}

export async function dispatchForgejoClaimed(input: {
  delivery: ForgejoVerifiedDelivery;
  receiptId: string;
  connection: ForgejoConnectionContext;
  consumers?: ForgejoConsumerRegistry;
}): Promise<ForgejoDispatchObservation> {
  const consumers = input.consumers ?? registry;
  const result = normalizeForgejoDelivery({
    delivery: input.delivery,
    connection: input.connection,
  });
  if (result.kind === "unclassified") {
    return {
      result,
      workflow: skipped(),
      configSync: skipped(),
      hydration: skipped(),
    };
  }
  if (result.kind === "signal") {
    return {
      result,
      workflow: skipped(),
      configSync: skipped(),
      hydration: await observe(() =>
        consumers.hydration?.consume({
          receiptId: input.receiptId,
          delivery: input.delivery,
          signal: result.signal,
        }),
      ),
    };
  }
  const [workflow, configSync] = await Promise.all([
    observeAll(() =>
      workflowList(consumers).map((consumer) =>
        consumer.consume({
          receiptId: input.receiptId,
          delivery: input.delivery,
          event: result.event,
        }),
      ),
    ),
    isForgejoDefaultBranchPush(result.event)
      ? observe(() =>
          consumers.configSync?.consume({
            receiptId: input.receiptId,
            delivery: input.delivery,
            event: result.event,
          }),
        )
      : Promise.resolve(skipped()),
  ]);
  return { result, workflow, configSync, hydration: skipped() };
}

function workflowList(consumers: ForgejoConsumerRegistry): readonly ForgejoWorkflowRunConsumer[] {
  const workflow = consumers.workflow;
  if (workflow === undefined) return workflowConsumers;
  if ("consume" in workflow) return [workflow];
  return workflow;
}

function skipped(): ForgejoConsumerObservation {
  return { status: "skipped" };
}

async function observeAll(
  run: () => readonly Promise<void>[],
): Promise<ForgejoConsumerObservation> {
  const pending = run();
  if (pending.length === 0) return { status: "unregistered" };
  const results = await Promise.all(pending.map((item) => observe(() => item)));
  const failed = results.find((result) => result.status === "failed");
  return failed ?? { status: "succeeded" };
}

async function observe(run: () => Promise<void> | undefined): Promise<ForgejoConsumerObservation> {
  const pending = run();
  if (pending === undefined) return { status: "unregistered" };
  try {
    await pending;
    return { status: "succeeded" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "forgejo_consumer_failed";
    logger.warn({ err: error }, "forgejo dual-dispatch consumer failed");
    return { status: "failed", error: message };
  }
}
