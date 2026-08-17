import type { DatabaseRuntime, QueryRow } from "../../db/runtime/index.js";
import { reportFailure } from "../../failures/index.js";
import type { SlackDeliveryStatus } from "../../triggers/slack/source/index.js";
import { slackActionPolicy } from "../../triggers/slack/source/health-policy.js";
import { PROVIDER_OBSERVATION_LIFETIME_SECONDS } from "./observation-lifetime.js";
import type {
  ProviderApplicationStore,
  ProviderRuntimeCandidate,
  ProviderRuntimeOwner,
} from "../index.js";

interface ActivationRow extends QueryRow {
  provider_application_id: string;
  configuration_version: number;
}

/** @package */
export function createProviderRuntimeReconciler(options: {
  database: DatabaseRuntime;
  store: Pick<ProviderApplicationStore, "read">;
  runtime: ProviderRuntimeOwner;
  callbackOrigin: string;
  instanceId: string;
  environmentManaged: boolean;
  intervalMs?: number;
}): { start(): void; stop(): Promise<void> } {
  let stopped = true;
  let timer: NodeJS.Timeout | undefined;
  let running = Promise.resolve();
  let failureActive = false;
  const intervalMs = options.intervalMs ?? 5_000;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick().finally(schedule);
    }, intervalMs);
    timer.unref();
  };

  const tick = async () => {
    let reconciliationFailure: unknown;
    try {
      if (!options.environmentManaged) {
        try {
          await reconcileActivation();
        } catch (error) {
          reconciliationFailure = error;
        }
      }
      await writeObservation();
      if (reconciliationFailure !== undefined) throw reconciliationFailure;
      failureActive = false;
    } catch (error) {
      if (!failureActive) {
        failureActive = true;
        reportFailure(error, {
          operation: "provider_application.reconcile",
          component: "provider_applications",
          provider: "slack",
        });
      }
    }
  };

  const reconcileActivation = async () => {
    const activation = await options.database.query<ActivationRow>(
      `select provider_application_id, configuration_version
       from runtime_provider_activation where provider = 'slack'`,
    );
    const active = activation.rows[0];
    const published = options.runtime.publishedApplication?.("slack");
    if (
      active === undefined ||
      (published !== undefined && active.configuration_version <= published.configurationVersion)
    ) {
      return;
    }
    const stored = await options.store.read("slack");
    if (
      stored === undefined ||
      stored.version !== active.configuration_version ||
      stored.identity.id !== active.provider_application_id
    ) {
      return;
    }
    let candidate: ProviderRuntimeCandidate | undefined;
    try {
      candidate = await options.runtime.prepare(
        "slack",
        stored.configuration,
        options.callbackOrigin,
        stored.identity,
        stored.version,
      );
      await candidate.start();
      candidate.publish();
      candidate = undefined;
    } finally {
      await candidate?.close();
    }
  };

  const writeObservation = async () => {
    const published = options.runtime.publishedApplication?.("slack");
    if (
      published?.configuration.provider !== "slack" ||
      published.configuration.transport !== "socket"
    ) {
      await deleteObservation();
      return;
    }
    const status = options.runtime.slackDeliveryStatus?.();
    if (status === undefined || status.state === "stopped") return;
    const state = observationState(status);
    const reason = observationReason(status);
    await options.database.query(
      `insert into runtime_provider_instances
         (provider, instance_id, provider_application_id, configuration_version, state, reason,
          delayed_workspaces, observed_at)
       values ('slack', $1, $2, $3, $4, $5, $6::jsonb, now())
       on conflict (provider, instance_id) do update set
         provider_application_id = excluded.provider_application_id,
         configuration_version = excluded.configuration_version,
         state = excluded.state,
         reason = excluded.reason,
         delayed_workspaces = excluded.delayed_workspaces,
         observed_at = excluded.observed_at`,
      [
        options.instanceId,
        published.identity.id,
        published.configurationVersion,
        state,
        reason,
        "[]",
      ],
    );
    await options.database.query(
      `delete from runtime_provider_instances
       where provider = 'slack' and configuration_version <> $1
         and observed_at < now() - ($2 * interval '1 second')`,
      [published.configurationVersion, PROVIDER_OBSERVATION_LIFETIME_SECONDS],
    );
  };

  const deleteObservation = () =>
    options.database
      .query(
        `delete from runtime_provider_instances where provider = 'slack' and instance_id = $1`,
        [options.instanceId],
      )
      .then(() => undefined);

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      running = tick().finally(schedule);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
      await deleteObservation();
    },
  };
}

function observationState(status: SlackDeliveryStatus): string {
  if (status.state === "actionNeeded") return "action_needed";
  return status.state;
}

function observationReason(status: SlackDeliveryStatus): string | null {
  if (status.state === "connected" && status.connectionLimitReached === true) {
    return "connection_limit";
  }
  if (status.state !== "actionNeeded") return null;
  return slackActionPolicy(status.reason).persistenceReason;
}
