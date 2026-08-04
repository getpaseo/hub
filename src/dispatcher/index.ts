import { DatabaseUnavailableError } from "../db/errors.js";
import type { Database, DurableTrigger } from "../db/types.js";
import type {
  TriggerDispatchOutcome,
  TriggerEventName,
  TriggerHandler,
  TriggerProvider,
} from "../triggers/index.js";
import { logger } from "../logger.js";
export { buildLaunchMachineIntent, type LaunchMachineIntent } from "./launch-machine-intent.js";
import { buildLaunchMachineIntent, type LaunchMachineIntent } from "./launch-machine-intent.js";

export interface DispatcherOptions {
  database: Database | null;
  providers?: readonly TriggerProvider[];
  dispatchLaunchMachineIntent?: (intent: LaunchMachineIntent) => Promise<unknown>;
  dispatchLaunchMachineIntents?: (intents: readonly LaunchMachineIntent[]) => Promise<unknown>;
  freezeDispatchPlan?: boolean;
  configurationRevisionId?: string;
}

export function createDispatcher(options: DispatcherOptions): TriggerHandler {
  const deliveries = new Map<string, Promise<TriggerDispatchOutcome>>();
  return async function handleTrigger(trigger): Promise<TriggerDispatchOutcome> {
    const deliveryKey = `${trigger.deliveryId}:${trigger.projectId}`;
    const active = deliveries.get(deliveryKey);
    if (active !== undefined) return active;

    const dispatch = dispatchTrigger(options, trigger);
    deliveries.set(deliveryKey, dispatch);
    try {
      return await dispatch;
    } finally {
      if (deliveries.get(deliveryKey) === dispatch) {
        deliveries.delete(deliveryKey);
      }
    }
  };
}

async function dispatchTrigger(
  options: DispatcherOptions,
  trigger: DurableTrigger,
): Promise<TriggerDispatchOutcome> {
  if (options.database === null) {
    throw new DatabaseUnavailableError();
  }

  const existing = options.freezeDispatchPlan
    ? await options.database.findTriggerById(trigger.triggerId)
    : undefined;
  let intents = existing?.dispatchPlan ?? null;
  if (intents === null) {
    const matches = await collectProviderMatches(options.providers ?? [], trigger);

    if (matches.length === 0) {
      await options.database.markTriggerDropped(trigger.triggerId, "no_matching_trigger");
      logger.info(
        {
          source: trigger.source,
          deliveryId: trigger.deliveryId,
          triggerId: trigger.triggerId,
        },
        "skipping trigger with no matching configured triggers",
      );
      return { triggerId: trigger.triggerId };
    }

    intents = matches.map((match) =>
      buildLaunchMachineIntent({
        ...match,
        organizationId: trigger.organizationId,
        projectId: trigger.projectId,
        triggerId: trigger.triggerId,
        configurationRevisionId:
          match.configurationRevisionId ?? options.configurationRevisionId ?? "manual-config",
      }),
    );
    if (options.freezeDispatchPlan) {
      intents = (await options.database.claimTriggerDispatchPlan(trigger.triggerId, intents)).plan;
    }
  }

  if (
    options.dispatchLaunchMachineIntent === undefined &&
    options.dispatchLaunchMachineIntents === undefined
  ) {
    logger.error(
      {
        source: trigger.source,
        deliveryId: trigger.deliveryId,
        triggerId: trigger.triggerId,
      },
      "no dispatch handler registered",
    );
    throw new Error("no dispatch handler registered");
  }

  if (options.dispatchLaunchMachineIntents !== undefined) {
    await options.dispatchLaunchMachineIntents(intents);
  } else {
    for (const intent of intents) {
      await options.dispatchLaunchMachineIntent!(intent);
    }
  }
  return { triggerId: trigger.triggerId };
}

async function collectProviderMatches(
  providers: readonly TriggerProvider[],
  trigger: Parameters<TriggerHandler>[0],
) {
  if (!isTriggerEventName(trigger.source)) {
    return [];
  }

  const source = trigger.source;
  const matchingProviders = providers.filter((provider) => provider.eventNames.includes(source));
  const nestedMatches = await Promise.all(
    matchingProviders.map((provider) => provider.match(trigger)),
  );

  return nestedMatches.flat();
}

function isTriggerEventName(source: string): source is TriggerEventName {
  return source.includes(".");
}
