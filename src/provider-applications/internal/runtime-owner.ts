import { createHash } from "node:crypto";
import type { AuthServer } from "../../auth/server.js";
import type { Database } from "../../db/types.js";

import { reportFailure } from "../../failures/index.js";
import { logger } from "../../logger.js";
import type {
  ProviderRegistration,
  TriggerProviderResources,
} from "../../providers/registration.js";
import type { TriggerHandler, TriggerProvider, TriggerSource } from "../../triggers/index.js";
import type {
  ProviderApplicationConfiguration,
  ProviderApplicationIdentity,
  ProviderRuntimeCandidate,
  ProviderRuntimeOwner,
} from "../index.js";

import type { ProviderInstallation, ProviderRegistry } from "../../providers/registry.js";
import type { SlackDeliveryStatus } from "../../triggers/slack/source/index.js";

interface Slot {
  active: ActiveRegistration | undefined;
  identity: ProviderApplicationIdentity | undefined;
  triggerResources: TriggerProviderResources | undefined;
  handler: TriggerHandler | undefined;
}

interface ActiveRegistration {
  provider: string;
  registration: ProviderRegistration;
  triggers: readonly TriggerProvider[];
  sourcesStarted: boolean;
  acceptingEvents: boolean;
  leases: number;
  retiring: boolean;
  retirement: Promise<void> | undefined;
}

class ProviderRuntimeUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code.replaceAll("_", " "));
    this.name = "ProviderRuntimeUnavailableError";
  }
}

function unavailable(code: string): ProviderRuntimeUnavailableError {
  return new ProviderRuntimeUnavailableError(code);
}

interface DynamicProviderRuntimeOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  fetch?: typeof fetch;
  registry: ProviderRegistry;
}

/** @package */
export class DynamicProviderRuntime implements ProviderRuntimeOwner {
  private readonly slots = new Map<string, Slot>();
  private readonly stable = new Map<string, ProviderRegistration>();
  private readonly installationHandlers = new Map<
    string,
    (operation: ProviderInstallation) => Promise<void>
  >();

  constructor(private readonly options: DynamicProviderRuntimeOptions) {
    for (const module of options.registry.list()) this.slots.set(module.manifest.id, emptySlot());
    // Preserve the existing connection projection order independently of application setup order.
    for (const module of [...options.registry.list()].sort(
      (left, right) => (left.manifest.connectionOrder ?? 0) - (right.manifest.connectionOrder ?? 0),
    )) {
      this.stable.set(module.manifest.id, this.stableRegistration(module.manifest.id));
    }
  }

  registrations(): readonly ProviderRegistration[] {
    return [...this.stable.values()];
  }

  onInstallation(
    provider: string,
    handler: (operation: ProviderInstallation) => Promise<void>,
  ): void {
    this.options.registry.require(provider);
    this.installationHandlers.set(provider, handler);
  }

  identity(provider: string): ProviderApplicationIdentity | undefined {
    return this.slot(provider).identity;
  }

  delivery(
    provider: string,
  ): { status(): SlackDeliveryStatus; retry(): Promise<void> } | undefined {
    return this.slot(provider).active?.registration.slackDelivery;
  }

  async prepare(
    provider: string,
    configuration: ProviderApplicationConfiguration,
    callbackOrigin: string,
    identity: ProviderApplicationIdentity,
    configurationVersion: number,
    activation?: {
      expectedConfigurationVersion: number | undefined;
      activateConfiguration: boolean;
    },
  ): Promise<ProviderRuntimeCandidate> {
    const registration = this.build(
      provider,
      configuration,
      callbackOrigin,
      configurationVersion,
      activation,
    );
    const slot = this.slot(provider);
    const triggerResources = slot.triggerResources;
    const active: ActiveRegistration = {
      provider,
      registration,
      triggers:
        triggerResources === undefined
          ? []
          : registration.triggerProviders
              .map((factory) => factory(triggerResources))
              .filter((trigger): trigger is TriggerProvider => trigger !== undefined),
      sourcesStarted: false,
      acceptingEvents: false,
      leases: 0,
      retiring: false,
      retirement: undefined,
    };
    let published = false;
    return {
      start: async () => {
        if (slot.handler === undefined) return;
        await startSources(active, slot.handler);
      },
      beginConnection: async (request) => {
        const response = await registration.connection.actions["start"]?.(request);
        if (response === undefined || !response.ok)
          throw unavailable("provider_application_unavailable");
        const body: unknown = await response.json();
        const url =
          body !== null && typeof body === "object" && "url" in body
            ? Reflect.get(body, "url")
            : undefined;
        if (typeof url !== "string") throw unavailable("provider_application_unavailable");
        return { url };
      },
      publish: () => {
        const previous = slot.active;
        if (previous !== undefined) previous.acceptingEvents = false;
        slot.active = active;
        slot.identity = identity;
        active.acceptingEvents = true;
        published = true;
        if (previous !== undefined) {
          previous.retiring = true;
          void stopSources(previous).catch((error: unknown) => {
            reportFailure(error, {
              operation: "provider_runtime.retire_inbound",
              component: "provider_runtime",
              provider,
            });
          });
          void this.retireWhenDrained(provider, previous);
        }
      },
      close: () => (published ? Promise.resolve() : stopSources(active)),
    };
  }

  private build(
    provider: string,
    configuration: unknown,
    callbackOrigin: string,
    configurationVersion: number,
    activation?: {
      expectedConfigurationVersion: number | undefined;
      activateConfiguration: boolean;
    },
  ): ProviderRegistration {
    const module = this.options.registry.require(provider);
    const parsed = module.application.parseConfiguration(configuration);
    if (parsed.provider !== provider) throw new Error("provider configuration mismatch");
    return module.createRuntime({
      database: this.options.database,
      auth: this.options.auth,
      applicationBaseUrl: this.options.applicationBaseUrl,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      configuration: parsed,
      callbackOrigin,
      configurationVersion,
      expectedConfigurationVersion: activation?.expectedConfigurationVersion,
      activateConfiguration: activation?.activateConfiguration ?? false,
      onInstallation: (operation) => {
        const handler = this.installationHandlers.get(provider);
        if (handler === undefined)
          throw unavailable(`${provider}_installation_handler_unavailable`);
        return handler(operation);
      },
    });
  }

  private stableRegistration(provider: string): ProviderRegistration {
    const slot = this.slot(provider);
    const manifest = this.options.registry.require(provider).manifest;
    const source: TriggerSource = {
      start: async (handler) => {
        slot.handler = handler;
        if (slot.active !== undefined) await startSources(slot.active, handler);
      },
      stop: async () => {
        slot.handler = undefined;
        if (slot.active !== undefined) {
          slot.active.acceptingEvents = false;
          await stopSources(slot.active);
        }
      },
    };
    const connectionActions = Object.fromEntries(
      manifest.actions.map((action) => [
        action,
        async (request: Request) => {
          const active = await this.registrationForAction(provider, slot, action, request);
          if (active === undefined) {
            return Response.json({ error: "provider_not_configured" }, { status: 409 });
          }
          return this.withLease(
            active,
            () =>
              active.registration.connection.actions[action]?.(request) ??
              Promise.resolve(Response.json({ error: "provider_not_configured" }, { status: 409 })),
          );
        },
      ]),
    );
    return {
      connection: {
        name: provider,
        status: (connections) =>
          slot.active?.registration.connection.status(connections) ?? {
            status: "notConfigured" as const,
          },
        actions: connectionActions,
      },
      ...(manifest.integration !== undefined
        ? {
            integration: {
              resolve: (
                ...args: Parameters<NonNullable<ProviderRegistration["integration"]>["resolve"]>
              ) => {
                const active = slot.active;
                const integration = active?.registration.integration;
                if (active === undefined || integration === undefined) {
                  throw unavailable(`${provider}_integration_unavailable`);
                }
                return this.withLease(active, () => integration.resolve(...args));
              },
              ...(manifest.integration.repositoryAuthority
                ? {
                    githubAuthority: {
                      mint: (
                        input: Parameters<
                          NonNullable<
                            NonNullable<ProviderRegistration["integration"]>["githubAuthority"]
                          >["mint"]
                        >[0],
                      ) => {
                        const active = slot.active;
                        const authority = active?.registration.integration?.githubAuthority;
                        if (active === undefined || authority === undefined) {
                          throw unavailable(`${provider}_authority_unavailable`);
                        }
                        return this.withLease(active, () => authority.mint(input));
                      },
                      revoke: (token: string) => {
                        const active = slot.active;
                        const authority = active?.registration.integration?.githubAuthority;
                        if (active === undefined || authority === undefined) {
                          throw unavailable(`${provider}_authority_unavailable`);
                        }
                        return this.withLease(active, () => authority.revoke(token));
                      },
                    },
                  }
                : {}),
            },
          }
        : {}),
      triggerProviders: [
        (resources) => {
          slot.triggerResources = resources;
          if (slot.active !== undefined) {
            slot.active.triggers = slot.active.registration.triggerProviders
              .map((factory) => factory(resources))
              .filter((trigger): trigger is TriggerProvider => trigger !== undefined);
          }
          return this.dynamicTrigger(provider, slot);
        },
      ],
      sources: [source],
      outputs: manifest.outputs.map((declaration) => ({
        ...declaration,
        available: (context) => {
          const output = slot.active?.registration.outputs.find(
            (candidate) => candidate.type === declaration.type,
          );
          return output !== undefined && (output.available?.(context) ?? true);
        },
        execute: (input) => {
          const active = slot.active;
          const output = active?.registration.outputs.find(
            (candidate) => candidate.type === declaration.type,
          );
          if (active === undefined || output === undefined) {
            throw unavailable(`${provider}_output_unavailable`);
          }
          return this.withLease(active, () => output.execute(input));
        },
      })),
      requests: manifest.requests.map((name) => ({
        name,
        handle: (request) => {
          const active = slot.active;
          const handler = active?.registration.requests.find(
            (candidate) => candidate.name === name,
          );
          return active === undefined || handler === undefined
            ? Promise.resolve(new Response("Not Found", { status: 404 }))
            : this.withLease(active, () => handler.handle(request));
        },
      })),
      ...(manifest.attachment !== undefined
        ? {
            attachment: {
              provider: manifest.attachment,
              resolve: (input) => {
                const active = slot.active;
                const attachment = active?.registration.attachment;
                if (active === undefined || attachment === undefined) {
                  throw unavailable(`${provider}_attachment_unavailable`);
                }
                return this.withLease(active, () => attachment.resolve(input));
              },
            },
          }
        : {}),
    };
  }

  private slot(provider: string): Slot {
    const slot = this.slots.get(provider);
    if (slot === undefined) throw new Error(`unknown provider: ${provider}`);
    return slot;
  }

  private dynamicTrigger(provider: string, slot: Slot): TriggerProvider {
    const current = () => {
      const active = slot.active;
      const trigger = active?.triggers[0];
      if (active === undefined || trigger === undefined) {
        throw unavailable(`${provider}_trigger_unavailable`);
      }
      return { active, trigger };
    };
    const invoke = <T>(operation: (trigger: TriggerProvider) => Promise<T>) => {
      const selected = current();
      return this.withLease(selected.active, () => operation(selected.trigger));
    };
    return {
      name: provider,
      eventNames: this.options.registry.require(provider).manifest.events,
      match: async (external) => {
        const selected = current();
        return this.withLease(selected.active, () => selected.trigger.match(external));
      },
      materializeLaunch: (input) =>
        invoke((trigger) => trigger.materializeLaunch?.(input) ?? Promise.resolve({})),
      materializeContext: (input) =>
        invoke((trigger) => trigger.materializeContext?.(input) ?? Promise.resolve(undefined)),
      onDispatchAccepted: (triggerContext, outputContext, reactionState) =>
        invoke(
          (trigger) =>
            trigger.onDispatchAccepted?.(triggerContext, outputContext, reactionState) ??
            Promise.resolve(),
        ),
      onAgentExecutionStarted: (triggerContext, outputContext, reactionState) =>
        invoke(
          (trigger) =>
            trigger.onAgentExecutionStarted?.(triggerContext, outputContext, reactionState) ??
            Promise.resolve(),
        ),
      onAgentExecutionCompleted: (triggerContext, outputContext, result, reactionState) =>
        invoke(
          (trigger) =>
            trigger.onAgentExecutionCompleted?.(
              triggerContext,
              outputContext,
              result,
              reactionState,
            ) ?? Promise.resolve(),
        ),
      onAgentExecutionFailed: (triggerContext, outputContext, reason, reactionState) =>
        invoke(
          (trigger) =>
            trigger.onAgentExecutionFailed?.(
              triggerContext,
              outputContext,
              reason,
              reactionState,
            ) ?? Promise.resolve(),
        ),
      onAgentExecutionTerminal: (executionId, triggerContext) =>
        invoke(
          (trigger) =>
            trigger.onAgentExecutionTerminal?.(executionId, triggerContext) ?? Promise.resolve(),
        ),
      onMachineTerminated: (triggerContext, reason, reactionState) =>
        invoke(
          (trigger) =>
            trigger.onMachineTerminated?.(triggerContext, reason, reactionState) ??
            Promise.resolve(),
        ),
    };
  }

  private async withLease<T>(active: ActiveRegistration, operation: () => Promise<T>): Promise<T> {
    active.leases += 1;
    try {
      return await operation();
    } finally {
      active.leases -= 1;
      if (active.retiring) {
        void this.retireWhenDrained(active.provider, active);
      }
    }
  }

  private retireWhenDrained(provider: string, active: ActiveRegistration): Promise<void> {
    if (active.leases > 0) return Promise.resolve();
    active.retirement ??= retire(provider, active);
    return active.retirement;
  }

  private async registrationForAction(
    provider: string,
    slot: Slot,
    action: string,
    request: Request,
  ): Promise<ActiveRegistration | undefined> {
    if (action !== "callback" && action !== "setup") return slot.active;
    const state = new URL(request.url).searchParams.get("state");
    if (state === null) return slot.active;
    const snapshot = await this.options.database.findConnectionAttemptConfiguration(
      createHash("sha256").update(state).digest("hex"),
    );
    if (snapshot === undefined) return slot.active;
    const existing =
      slot.active?.registration.configurationSnapshot?.version === snapshot.configurationVersion &&
      slot.active.registration.configurationSnapshot.callbackOrigin === snapshot.callbackOrigin
        ? slot.active
        : undefined;
    if (existing !== undefined) return existing;
    try {
      const configuration = this.options.registry
        .require(provider)
        .application.parseConfiguration(snapshot.configurationSnapshot);
      if (configuration.provider !== provider) return slot.active;
      const registration = this.build(
        provider,
        configuration,
        snapshot.callbackOrigin,
        snapshot.configurationVersion,
        {
          expectedConfigurationVersion: snapshot.expectedConfigurationVersion ?? undefined,
          activateConfiguration: snapshot.activateConfiguration,
        },
      );
      const restored: ActiveRegistration = {
        provider,
        registration,
        triggers: [],
        sourcesStarted: false,
        acceptingEvents: false,
        leases: 0,
        retiring: false,
        retirement: undefined,
      };
      return restored;
    } catch (error) {
      reportFailure(error, {
        operation: "provider_runtime.restore_callback_snapshot",
        component: "provider_runtime",
        provider,
      });
      return slot.active;
    }
  }
}

function emptySlot(): Slot {
  return {
    active: undefined,
    identity: undefined,
    triggerResources: undefined,
    handler: undefined,
  };
}

async function startSources(active: ActiveRegistration, handler: TriggerHandler): Promise<void> {
  if (active.sourcesStarted) return;
  const started: TriggerSource[] = [];
  try {
    for (const source of active.registration.sources) {
      await source.start((trigger) =>
        active.acceptingEvents
          ? handler(trigger)
          : Promise.reject(new Error("provider source was retired")),
      );
      started.push(source);
    }
    active.sourcesStarted = true;
  } catch (error) {
    const cleanup = await Promise.allSettled(started.toReversed().map((source) => source.stop()));
    for (const failure of cleanup) {
      if (failure.status === "rejected") {
        reportFailure(failure.reason, {
          operation: "provider_runtime.start_sources.cleanup",
          component: "provider_runtime",
          provider: active.provider,
        });
      }
    }
    throw error;
  }
}

async function stopSources(active: ActiveRegistration): Promise<void> {
  if (!active.sourcesStarted) return;
  active.sourcesStarted = false;
  const results = await Promise.allSettled(
    active.registration.sources.toReversed().map((source) => source.stop()),
  );
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}

async function retire(provider: string, active: ActiveRegistration): Promise<void> {
  try {
    await stopSources(active);
  } catch (error) {
    reportFailure(
      error,
      { operation: "provider_runtime.retire", component: "provider_runtime", provider },
      { logger, kind: "internal" },
    );
  }
}
