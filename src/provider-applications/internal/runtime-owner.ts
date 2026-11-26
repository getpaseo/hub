import type { AuthServer } from "../../auth/server.js";
import { createHash } from "node:crypto";
import {
  connectionAccess,
  connectionActionFailure,
  manageConnectionAccess,
  requiredConnectionId,
} from "../../connections/shared.js";
import type { Database } from "../../db/types.js";
import { replyOutputTool } from "../../execution-capabilities/outputs.js";
import { logger } from "../../logger.js";
import { reportFailure } from "../../failures/index.js";
import { IntegrationToolError, type IntegrationToolCall } from "../../integration-tools/index.js";
import type {
  IntegrationDefinition,
  IntegrationInboundEvent,
  IntegrationInboundProcessor,
  IntegrationInboundSink,
  IntegrationOAuthCompletionInput,
  IntegrationToolGrantBase,
} from "../../integrations/contracts.js";
import {
  defaultIntegrationRegistry,
  type IntegrationRegistry,
} from "../../integrations/registry.js";
import { createDiscordRegistration } from "../../providers/discord/index.js";
import { createGitHubRegistration } from "../../providers/github/index.js";
import { GITHUB_CONNECTION_ACTIONS } from "../../providers/github/connection.js";
import { createLinearRegistration } from "../../providers/linear/index.js";
import type {
  ProviderRegistration,
  TriggerProviderResources,
} from "../../providers/registration.js";
import { createSlackRegistration } from "../../providers/slack/index.js";
import type { TriggerHandler, TriggerProvider, TriggerSource } from "../../triggers/index.js";
import {
  isLegacyProvider,
  isLegacyProviderApplicationConfiguration,
  type AnyProviderApplicationConfiguration,
  type AnyProviderApplicationIdentity,
  type ApplicationProvider,
  type Provider,
  type ProviderApplicationConfiguration,
  type ProviderRuntimeCandidate,
  type ProviderRuntimeOwner,
} from "../index.js";
import { parseProviderApplicationConfiguration } from "./store.js";
import type { SlackDeliveryStatus } from "../../triggers/slack/source/index.js";
import { GITHUB_TRIGGER_SOURCE_NAMES } from "../../triggers/github/classification.js";

interface Slot {
  active: ActiveRegistration | undefined;
  identity: AnyProviderApplicationIdentity | undefined;
  triggerResources: TriggerProviderResources | undefined;
  handler: TriggerHandler | undefined;
}

interface ActiveRegistration {
  provider: ApplicationProvider;
  registration: ProviderRegistration;
  triggers: readonly TriggerProvider[];
  closeRuntime?: (() => Promise<void>) | undefined;
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

type SlackInstallationHandler = Parameters<
  NonNullable<ProviderRuntimeOwner["onSlackInstallation"]>
>[0];
type LinearInstallationHandler = Parameters<
  NonNullable<ProviderRuntimeOwner["onLinearInstallation"]>
>[0];
type IntegrationOAuthInstallationHandler = (
  input: IntegrationOAuthCompletionInput,
) => Promise<void>;

interface DynamicProviderRuntimeOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
  registry?: IntegrationRegistry;
  inboundSink?: IntegrationInboundSink;
  registrationFactory?: (input: {
    provider: Provider;
    configuration: ProviderApplicationConfiguration;
    callbackOrigin: string;
    configurationVersion: number;
    expectedConfigurationVersion: number | undefined;
    activateConfiguration: boolean;
    onVerifiedSlackInstallation: SlackInstallationHandler;
    onVerifiedLinearInstallation: LinearInstallationHandler;
  }) => ProviderRegistration;
}

/** @package */
export class DynamicProviderRuntime implements ProviderRuntimeOwner {
  private readonly registry: IntegrationRegistry;
  private readonly slots = new Map<ApplicationProvider, Slot>([
    ["github", emptySlot()],
    ["slack", emptySlot()],
    ["discord", emptySlot()],
    ["linear", emptySlot()],
  ]);
  private readonly stable = new Map<ApplicationProvider, ProviderRegistration>();
  private slackInstallationHandler: SlackInstallationHandler | undefined;
  private linearInstallationHandler: LinearInstallationHandler | undefined;
  private integrationOAuthHandler: IntegrationOAuthInstallationHandler | undefined;

  constructor(private readonly options: DynamicProviderRuntimeOptions) {
    this.registry = options.registry ?? defaultIntegrationRegistry;
    for (const provider of ["github", "slack", "discord", "linear"] as const) {
      this.stable.set(provider, this.stableRegistration(provider));
    }
    for (const integration of this.registry.all()) {
      this.slots.set(integration.id, emptySlot());
      this.stable.set(integration.id, this.stableIntegrationRegistration(integration));
    }
  }

  registrations(): readonly ProviderRegistration[] {
    return [
      this.stable.get("github")!,
      this.stable.get("discord")!,
      this.stable.get("slack")!,
      this.stable.get("linear")!,
      ...this.registry.all().map((integration) => this.stable.get(integration.id)!),
    ];
  }

  identity(provider: ApplicationProvider): AnyProviderApplicationIdentity | undefined {
    return this.slot(provider).identity;
  }

  slackDelivery(): { status(): SlackDeliveryStatus; retry(): Promise<void> } | undefined {
    return this.slot("slack").active?.registration.slackDelivery;
  }

  onSlackInstallation(
    handler: NonNullable<DynamicProviderRuntime["slackInstallationHandler"]>,
  ): void {
    this.slackInstallationHandler = handler;
  }

  onLinearInstallation(
    handler: NonNullable<DynamicProviderRuntime["linearInstallationHandler"]>,
  ): void {
    this.linearInstallationHandler = handler;
  }

  onIntegrationOAuthInstallation(handler: IntegrationOAuthInstallationHandler): void {
    this.integrationOAuthHandler = handler;
  }

  async prepare(
    provider: ApplicationProvider,
    configuration: AnyProviderApplicationConfiguration,
    callbackOrigin: string,
    identity: AnyProviderApplicationIdentity,
    configurationVersion: number,
    activation?: {
      expectedConfigurationVersion: number | undefined;
      activateConfiguration: boolean;
    },
  ): Promise<ProviderRuntimeCandidate> {
    const slot = this.slot(provider);
    const built = this.build(
      provider,
      configuration,
      callbackOrigin,
      identity,
      configurationVersion,
      slot,
      activation,
    );
    const { registration, closeRuntime } = built;
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
      closeRuntime,
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
      close: async () => {
        if (published) return;
        await stopSources(active);
        await closeRuntime?.();
      },
    };
  }

  private build(
    provider: ApplicationProvider,
    configuration: AnyProviderApplicationConfiguration,
    callbackOrigin: string,
    identity: AnyProviderApplicationIdentity,
    configurationVersion: number,
    slot: Slot,
    activation?: {
      expectedConfigurationVersion: number | undefined;
      activateConfiguration: boolean;
    },
  ): { registration: ProviderRegistration; closeRuntime?: () => Promise<void> } {
    const registered = this.registry.get(provider);
    if (registered !== undefined) {
      return this.buildIntegrationRegistration(
        registered,
        configuration,
        callbackOrigin,
        identity,
        configurationVersion,
        slot,
        activation,
      );
    }
    if (!isLegacyProvider(provider) || !isLegacyProviderApplicationConfiguration(configuration)) {
      throw new Error("provider configuration mismatch");
    }
    return {
      registration: this.buildLegacyRegistration(
        provider,
        configuration,
        callbackOrigin,
        configurationVersion,
        activation,
      ),
    };
  }

  private buildLegacyRegistration(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
    callbackOrigin: string,
    configurationVersion: number,
    activation?: {
      expectedConfigurationVersion: number | undefined;
      activateConfiguration: boolean;
    },
  ): ProviderRegistration {
    if (this.options.registrationFactory !== undefined) {
      return this.options.registrationFactory(
        this.customRegistrationInput(
          provider,
          configuration,
          callbackOrigin,
          configurationVersion,
          activation,
        ),
      );
    }
    const shared = {
      database: this.options.database,
      auth: this.options.auth,
      applicationBaseUrl: this.options.applicationBaseUrl,
      publicBaseUrl: callbackOrigin,
      configurationVersion,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
    };
    if (provider === "github" && configuration.provider === "github") {
      return createGitHubRegistration({ ...shared, configuration });
    }
    if (provider === "slack" && configuration.provider === "slack") {
      return createSlackRegistration({
        ...shared,
        configuration,
        ...(activation?.expectedConfigurationVersion === undefined
          ? {}
          : { expectedConfigurationVersion: activation.expectedConfigurationVersion }),
        activateConfiguration: activation?.activateConfiguration ?? false,
        onVerifiedInstallation: (input) => this.handleSlackInstallation(input),
      });
    }
    if (provider === "discord" && configuration.provider === "discord") {
      return createDiscordRegistration({
        ...shared,
        configuration: {
          clientId: configuration.applicationId,
          clientSecret: configuration.clientSecret,
          botToken: configuration.botToken,
        },
      });
    }
    if (provider === "linear" && configuration.provider === "linear") {
      return createLinearRegistration({
        ...shared,
        configuration,
        ...(activation?.expectedConfigurationVersion === undefined
          ? {}
          : { expectedConfigurationVersion: activation.expectedConfigurationVersion }),
        activateConfiguration: activation?.activateConfiguration ?? false,
        onVerifiedInstallation: (input) => this.handleLinearInstallation(input),
      });
    }
    throw new Error("provider configuration mismatch");
  }

  private buildIntegrationRegistration(
    integration: IntegrationDefinition,
    configuration: AnyProviderApplicationConfiguration,
    callbackOrigin: string,
    identity: AnyProviderApplicationIdentity,
    configurationVersion: number,
    slot: Slot,
    activation?: {
      expectedConfigurationVersion: number | undefined;
      activateConfiguration: boolean;
    },
  ): { registration: ProviderRegistration; closeRuntime?: () => Promise<void> } {
    const now = this.options.now ?? (() => new Date());
    let processors: Readonly<Record<string, IntegrationInboundProcessor>> = {};
    const directIngest: IntegrationInboundSink = {
      enqueue: async (event: IntegrationInboundEvent) => {
        const processor = processors[event.kind];
        if (processor === undefined) {
          return { status: "rejected", reason: "unknown_inbound_kind" };
        }
        const handler = slot.handler;
        if (handler === undefined) {
          return { status: "rejected", reason: "trigger_handler_unavailable" };
        }
        const serializedPayload: unknown = JSON.parse(JSON.stringify(event.payload));
        await processor(
          {
            ...event,
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
            payload: serializedPayload as IntegrationInboundEvent["payload"],
          },
          handler,
        );
        return { status: "accepted" };
      },
    };

    const context = {
      database: this.options.database,
      auth: this.options.auth,
      callbackOrigin,
      identity,
      configurationVersion,
      ...(activation === undefined ? {} : { activation }),
      fetch: this.options.fetch ?? fetch,
      now,
      ingest: this.options.inboundSink ?? directIngest,
      onOAuthInstallation: (input: IntegrationOAuthCompletionInput) =>
        this.handleIntegrationOAuthInstallation(input),
    };

    const connectionRuntime = integration.connection.createRuntime(configuration, context);
    const triggersRuntime = integration.triggers?.createRuntime(configuration, context);
    if (triggersRuntime?.ingest !== undefined) {
      processors = triggersRuntime.ingest;
    }
    const toolHandler = integration.tools?.createHandler(configuration, context);
    const actions = this.buildIntegrationConnectionActions(integration.id, connectionRuntime);

    const registration: ProviderRegistration = {
      configurationSnapshot: { version: configurationVersion, callbackOrigin },
      connection: {
        name: integration.id,
        status: (connections) =>
          integration.connection.connectionStatus(
            (connections.integrations ?? []).filter(
              (connection) => connection.provider === integration.id,
            ),
            now(),
          ),
        actions,
      },
      triggerProviders: triggersRuntime === undefined ? [] : [triggersRuntime.triggerProvider],
      sources: triggersRuntime?.sources ?? [],
      outputs: triggersRuntime?.outputs ?? [],
      ...(toolHandler === undefined
        ? {}
        : { integrationTools: { registered: { [integration.id]: toolHandler } } }),
      requests: triggersRuntime?.requests ?? [],
    };
    return {
      registration,
      ...(connectionRuntime.close === undefined
        ? {}
        : {
            closeRuntime: async () => {
              await connectionRuntime.close?.();
            },
          }),
    };
  }

  private buildIntegrationConnectionActions(
    provider: string,
    connectionRuntime: ReturnType<IntegrationDefinition["connection"]["createRuntime"]>,
  ): Record<string, (request: Request) => Promise<Response>> {
    const actions: Record<string, (request: Request) => Promise<Response>> = {};
    for (const [name, handler] of Object.entries(connectionRuntime.actions ?? {})) {
      if (handler !== undefined) actions[name] = handler;
    }
    if (actions["start"] === undefined && connectionRuntime.beginConnection !== undefined) {
      actions["start"] = async (request) => {
        const rejected = this.options.auth.rejectCookieMutation(request);
        if (rejected !== undefined) return rejected;
        try {
          const access = await manageConnectionAccess(
            this.options.auth,
            this.options.database,
            request,
          );
          const started = await connectionRuntime.beginConnection!(
            request,
            connectionAccess(access),
          );
          return Response.json({ url: started.url });
        } catch (error) {
          return connectionActionFailure(error, provider, "start");
        }
      };
    }
    if (actions["disconnect"] === undefined) {
      actions["disconnect"] = async (request) => {
        const rejected = this.options.auth.rejectCookieMutation(request);
        if (rejected !== undefined) return rejected;
        try {
          const access = await manageConnectionAccess(
            this.options.auth,
            this.options.database,
            request,
          );
          await this.options.database.integrations.disconnect(
            provider,
            requiredConnectionId(request),
            connectionAccess(access),
          );
          return Response.json({ disconnected: true });
        } catch (error) {
          return connectionActionFailure(error, provider, "disconnect");
        }
      };
    }
    return actions;
  }

  private customRegistrationInput(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
    callbackOrigin: string,
    configurationVersion: number,
    activation:
      | {
          expectedConfigurationVersion: number | undefined;
          activateConfiguration: boolean;
        }
      | undefined,
  ): Parameters<NonNullable<DynamicProviderRuntimeOptions["registrationFactory"]>>[0] {
    return {
      provider,
      configuration,
      callbackOrigin,
      configurationVersion,
      expectedConfigurationVersion: activation?.expectedConfigurationVersion,
      activateConfiguration: activation?.activateConfiguration ?? false,
      onVerifiedSlackInstallation: (input) => this.handleSlackInstallation(input),
      onVerifiedLinearInstallation: (input) => this.handleLinearInstallation(input),
    };
  }

  private handleSlackInstallation(input: Parameters<SlackInstallationHandler>[0]): Promise<void> {
    if (this.slackInstallationHandler === undefined) {
      throw unavailable("slack_installation_handler_unavailable");
    }
    return this.slackInstallationHandler(input);
  }

  private handleLinearInstallation(input: Parameters<LinearInstallationHandler>[0]): Promise<void> {
    if (this.linearInstallationHandler === undefined) {
      throw unavailable("linear_installation_handler_unavailable");
    }
    return this.linearInstallationHandler(input);
  }

  private handleIntegrationOAuthInstallation(
    input: IntegrationOAuthCompletionInput,
  ): Promise<void> {
    if (this.integrationOAuthHandler === undefined) {
      throw unavailable("integration_oauth_handler_unavailable");
    }
    return this.integrationOAuthHandler(input);
  }

  private stableRegistration(provider: Provider): ProviderRegistration {
    const slot = this.slot(provider);
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
      actionNames(provider).map((action) => [
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
      ...(provider === "github"
        ? {
            integration: {
              resolve: (
                ...args: Parameters<NonNullable<ProviderRegistration["integration"]>["resolve"]>
              ) => {
                const active = slot.active;
                const integration = active?.registration.integration;
                if (active === undefined || integration === undefined) {
                  throw unavailable("github_integration_unavailable");
                }
                return this.withLease(active, () => integration.resolve(...args));
              },
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
                    throw unavailable("github_authority_unavailable");
                  }
                  return this.withLease(active, () => authority.mint(input));
                },
                revoke: (token: string) => {
                  const active = slot.active;
                  const authority = active?.registration.integration?.githubAuthority;
                  if (active === undefined || authority === undefined) {
                    throw unavailable("github_authority_unavailable");
                  }
                  return this.withLease(active, () => authority.revoke(token));
                },
              },
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
      ...(provider === "slack" || provider === "discord"
        ? {
            integrationTools: {
              [provider]: (input: IntegrationToolCall) => {
                const active = slot.active;
                const handler = active?.registration.integrationTools?.[provider];
                if (active === undefined || handler === undefined) {
                  throw new IntegrationToolError("The integration is unavailable.");
                }
                return this.withLease(active, () => handler(input));
              },
            },
          }
        : {}),
      outputs: [
        {
          type: `${provider}.reply`,
          tool: replyOutputTool,
          available: (context) => {
            const output = slot.active?.registration.outputs.find(
              (candidate) => candidate.type === `${provider}.reply`,
            );
            return output !== undefined && (output.available?.(context) ?? true);
          },
          execute: (input) => {
            const active = slot.active;
            const output = active?.registration.outputs.find(
              (candidate) => candidate.type === `${provider}.reply`,
            );
            if (active === undefined || output === undefined) {
              throw unavailable(`${provider}_output_unavailable`);
            }
            return this.withLease(active, () => output.execute(input));
          },
        },
      ],
      requests:
        provider === "discord"
          ? []
          : [
              {
                name: provider === "github" ? "webhook" : `${provider}.events`,
                handle: (request) => {
                  const active = slot.active;
                  const handler = active?.registration.requests[0];
                  return active === undefined || handler === undefined
                    ? Promise.resolve(new Response("Not Found", { status: 404 }))
                    : this.withLease(active, () => handler.handle(request));
                },
              },
            ],
      ...(provider === "slack" || provider === "discord"
        ? {
            attachment: {
              provider,
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

  private stableIntegrationRegistration(integration: IntegrationDefinition): ProviderRegistration {
    const provider = integration.id;
    const slot = this.slot(provider);
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
    const dispatchAction = async (action: string, request: Request): Promise<Response> => {
      const active = await this.registrationForAction(provider, slot, action, request);
      if (active === undefined) {
        return Response.json({ error: "provider_not_configured" }, { status: 409 });
      }
      const handler = active.registration.connection.actions[action];
      if (handler === undefined) {
        return Response.json({ error: "provider_not_configured" }, { status: 409 });
      }
      return this.withLease(active, () => handler(request));
    };
    const connectionActions = Object.fromEntries(
      ["start", "disconnect", "callback"].map((action) => [
        action,
        (request: Request) => dispatchAction(action, request),
      ]),
    );
    const replyTypes = [
      ...new Set(
        (integration.triggers?.events ?? [])
          .map((event) => event.replyType)
          .filter((type): type is string => type !== undefined),
      ),
    ];
    const outputs = replyTypes.map((type) => ({
      type,
      tool: replyOutputTool,
      available: (context: unknown) => {
        const output = slot.active?.registration.outputs.find(
          (candidate) => candidate.type === type,
        );
        return output !== undefined && (output.available?.(context) ?? true);
      },
      execute: (input: Parameters<ProviderRegistration["outputs"][number]["execute"]>[0]) => {
        const active = slot.active;
        const output = active?.registration.outputs.find((candidate) => candidate.type === type);
        if (active === undefined || output === undefined) {
          throw unavailable(`${provider}_output_unavailable`);
        }
        return this.withLease(active, () => output.execute(input));
      },
    }));

    return {
      connection: {
        name: provider,
        status: (connections) =>
          slot.active?.registration.connection.status(connections) ?? {
            status: "notConfigured" as const,
          },
        actions: connectionActions,
      },
      triggerProviders:
        integration.triggers === undefined
          ? []
          : [
              (resources) => {
                slot.triggerResources = resources;
                if (slot.active !== undefined) {
                  slot.active.triggers = slot.active.registration.triggerProviders
                    .map((factory) => factory(resources))
                    .filter((trigger): trigger is TriggerProvider => trigger !== undefined);
                }
                return this.dynamicTrigger(
                  provider,
                  slot,
                  integration.triggers!.events.map((event) => event.id),
                );
              },
            ],
      sources: [source],
      ...(integration.tools === undefined
        ? {}
        : {
            integrationTools: {
              registered: {
                [provider]: (input: IntegrationToolCall<IntegrationToolGrantBase>) => {
                  const active = slot.active;
                  const handler = active?.registration.integrationTools?.registered?.[provider];
                  if (active === undefined || handler === undefined) {
                    throw new IntegrationToolError("The integration is unavailable.");
                  }
                  return this.withLease(active, () => handler(input));
                },
              },
            },
          }),
      outputs,
      requests: [],
      ...(integration.triggers === undefined
        ? {}
        : {
            handleRequest: (name, request) => {
              if (!name.startsWith(`${provider}.`)) return undefined;
              const active = slot.active;
              const handler = active?.registration.requests.find(
                (candidate) => candidate.name === name,
              );
              return active === undefined || handler === undefined
                ? Promise.resolve(new Response("Not Found", { status: 404 }))
                : this.withLease(active, () => handler.handle(request));
            },
          }),
    };
  }

  private slot(provider: ApplicationProvider): Slot {
    const slot = this.slots.get(provider);
    if (slot === undefined) throw new Error(`unknown provider: ${provider}`);
    return slot;
  }

  private dynamicTrigger(
    provider: ApplicationProvider,
    slot: Slot,
    overrideEventNames?: readonly TriggerProvider["eventNames"][number][],
  ): TriggerProvider {
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
      eventNames: overrideEventNames ?? eventNames(provider),
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

  private retireWhenDrained(
    provider: ApplicationProvider,
    active: ActiveRegistration,
  ): Promise<void> {
    if (active.leases > 0) return Promise.resolve();
    active.retirement ??= retire(provider, active);
    return active.retirement;
  }

  private async registrationForAction(
    provider: ApplicationProvider,
    slot: Slot,
    action: string,
    request: Request,
  ): Promise<ActiveRegistration | undefined> {
    // An action that continues an attempt carries its state, and belongs to the registration
    // that started it, even if the operator has saved a new configuration since.
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
      const configuration = parseProviderApplicationConfiguration(
        snapshot.configurationSnapshot,
        this.registry,
      );
      if (configuration.provider !== provider) return slot.active;
      const integration = this.registry.get(provider);
      const identity: AnyProviderApplicationIdentity = integration?.connection.oauthAppIdentity?.(
        configuration,
      ) ??
        slot.identity ?? {
          provider,
          id: provider,
          name: integration?.label ?? provider,
        };
      const built = this.build(
        provider,
        configuration,
        snapshot.callbackOrigin,
        identity,
        snapshot.configurationVersion,
        slot,
        {
          expectedConfigurationVersion: snapshot.expectedConfigurationVersion ?? undefined,
          activateConfiguration: snapshot.activateConfiguration,
        },
      );
      const restored: ActiveRegistration = {
        provider,
        registration: built.registration,
        triggers: [],
        closeRuntime: built.closeRuntime,
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

function actionNames(provider: ApplicationProvider): readonly string[] {
  if (provider === "github") return GITHUB_CONNECTION_ACTIONS;
  return ["start", "disconnect", "callback"];
}

function eventNames(provider: ApplicationProvider): TriggerProvider["eventNames"] {
  if (provider === "slack") return ["slack.mention"];
  if (provider === "discord") return ["discord.mention"];
  if (provider === "linear") return ["linear.issue", "linear.comment"];
  return GITHUB_TRIGGER_SOURCE_NAMES;
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

async function retire(provider: ApplicationProvider, active: ActiveRegistration): Promise<void> {
  try {
    await stopSources(active);
    await active.closeRuntime?.();
  } catch (error) {
    reportFailure(
      error,
      { operation: "provider_runtime.retire", component: "provider_runtime", provider },
      { logger, kind: "internal" },
    );
  }
}
