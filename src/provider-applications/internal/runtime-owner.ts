import type { AuthServer } from "../../auth/server.js";
import { createHash } from "node:crypto";
import type { GitHubConfigurationProvider } from "../../configuration/github-sync.js";
import type { Database } from "../../db/types.js";
import { outputContextProvider, replyOutputTool } from "../../execution-capabilities/outputs.js";
import { logger } from "../../logger.js";
import { createDiscordRegistration } from "../../providers/discord/index.js";
import { createGitHubRegistration } from "../../providers/github/index.js";
import type {
  ProviderRegistration,
  TriggerProviderResources,
} from "../../providers/registration.js";
import { createSlackRegistration } from "../../providers/slack/index.js";
import type { TriggerHandler, TriggerProvider, TriggerSource } from "../../triggers/index.js";
import type {
  Provider,
  ProviderApplicationConfiguration,
  ProviderApplicationIdentity,
  ProviderRuntimeCandidate,
  ProviderRuntimeOwner,
} from "../index.js";
import { parseProviderApplicationConfiguration } from "./store.js";

interface Slot {
  active: ActiveRegistration | undefined;
  identity: ProviderApplicationIdentity | undefined;
  triggerResources: TriggerProviderResources | undefined;
  handler: TriggerHandler | undefined;
}

interface ActiveRegistration {
  registration: ProviderRegistration;
  triggers: readonly TriggerProvider[];
  sourcesStarted: boolean;
  acceptingEvents: boolean;
}

type SlackInstallationHandler = Parameters<
  NonNullable<ProviderRuntimeOwner["onSlackInstallation"]>
>[0];

interface DynamicProviderRuntimeOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  fetch?: typeof fetch;
  registrationFactory?: (input: {
    provider: Provider;
    configuration: ProviderApplicationConfiguration;
    callbackOrigin: string;
    configurationVersion: number;
    expectedConfigurationVersion: number | undefined;
    activateConfiguration: boolean;
    onVerifiedSlackInstallation: SlackInstallationHandler;
  }) => ProviderRegistration;
}

/** @package */
export class DynamicProviderRuntime implements ProviderRuntimeOwner {
  private readonly slots = new Map<Provider, Slot>([
    ["github", emptySlot()],
    ["slack", emptySlot()],
    ["discord", emptySlot()],
  ]);
  private readonly stable = new Map<Provider, ProviderRegistration>();
  private slackInstallationHandler: SlackInstallationHandler | undefined;

  constructor(private readonly options: DynamicProviderRuntimeOptions) {
    for (const provider of ["github", "slack", "discord"] as const) {
      this.stable.set(provider, this.stableRegistration(provider));
    }
  }

  registrations(): readonly ProviderRegistration[] {
    return [this.stable.get("github")!, this.stable.get("discord")!, this.stable.get("slack")!];
  }

  identity(provider: Provider): ProviderApplicationIdentity | undefined {
    return this.slot(provider).identity;
  }

  onSlackInstallation(
    handler: NonNullable<DynamicProviderRuntime["slackInstallationHandler"]>,
  ): void {
    this.slackInstallationHandler = handler;
  }

  async prepare(
    provider: Provider,
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
      registration,
      triggers:
        triggerResources === undefined
          ? []
          : registration.triggerProviders
              .map((factory) => factory(triggerResources))
              .filter((trigger): trigger is TriggerProvider => trigger !== undefined),
      sourcesStarted: false,
      acceptingEvents: false,
    };
    let published = false;
    return {
      start: async () => {
        if (slot.handler === undefined) return;
        await startSources(active, slot.handler);
      },
      beginConnection: async (request) => {
        const response = await registration.connection.actions["start"]?.(request);
        if (response === undefined || !response.ok) throw new Error("provider unavailable");
        const body: unknown = await response.json();
        const url =
          body !== null && typeof body === "object" && "url" in body
            ? Reflect.get(body, "url")
            : undefined;
        if (typeof url !== "string") throw new Error("provider unavailable");
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
          void retire(provider, previous);
        }
      },
      close: () => (published ? Promise.resolve() : stopSources(active)),
    };
  }

  private build(
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
      return this.options.registrationFactory({
        provider,
        configuration,
        callbackOrigin,
        configurationVersion,
        expectedConfigurationVersion: activation?.expectedConfigurationVersion,
        activateConfiguration: activation?.activateConfiguration ?? false,
        onVerifiedSlackInstallation: (input) => {
          if (this.slackInstallationHandler === undefined) {
            throw new Error("Slack installation handler unavailable");
          }
          return this.slackInstallationHandler(input);
        },
      });
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
        onVerifiedInstallation: (input) => {
          if (this.slackInstallationHandler === undefined) {
            throw new Error("Slack installation handler unavailable");
          }
          return this.slackInstallationHandler(input);
        },
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
    throw new Error("provider configuration mismatch");
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
          return (
            active?.registration.connection.actions[action]?.(request) ??
            Response.json({ error: "provider_not_configured" }, { status: 409 })
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
                const integration = slot.active?.registration.integration;
                if (integration === undefined) throw new Error("github integration unavailable");
                return integration.resolve(...args);
              },
              githubAuthority: {
                mint: (
                  input: Parameters<
                    NonNullable<
                      NonNullable<ProviderRegistration["integration"]>["githubAuthority"]
                    >["mint"]
                  >[0],
                ) => {
                  const authority = slot.active?.registration.integration?.githubAuthority;
                  if (authority === undefined) throw new Error("github authority unavailable");
                  return authority.mint(input);
                },
                revoke: (token: string) => {
                  const authority = slot.active?.registration.integration?.githubAuthority;
                  if (authority === undefined) throw new Error("github authority unavailable");
                  return authority.revoke(token);
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
          return dynamicTrigger(provider, slot);
        },
      ],
      sources: [source],
      outputs:
        provider === "github"
          ? []
          : [
              {
                type: `${provider}.reply`,
                tool: replyOutputTool,
                available: outputContextProvider(provider),
                execute: (input) => {
                  const output = slot.active?.registration.outputs.find(
                    (candidate) => candidate.type === `${provider}.reply`,
                  );
                  if (output === undefined) throw new Error(`${provider} output unavailable`);
                  return output.execute(input);
                },
              },
            ],
      requests:
        provider === "discord"
          ? []
          : [
              {
                name: provider === "github" ? "webhook" : "slack.events",
                handle: (request) =>
                  slot.active?.registration.requests[0]?.handle(request) ??
                  Promise.resolve(new Response("Not Found", { status: 404 })),
              },
            ],
      ...(provider === "github" ? { githubConfiguration: dynamicGitHubConfiguration(slot) } : {}),
      ...(provider === "slack" || provider === "discord"
        ? {
            attachment: {
              provider,
              resolve: (input) => {
                const attachment = slot.active?.registration.attachment;
                if (attachment === undefined) throw new Error(`${provider} attachment unavailable`);
                return attachment.resolve(input);
              },
            },
          }
        : {}),
    };
  }

  private slot(provider: Provider): Slot {
    const slot = this.slots.get(provider);
    if (slot === undefined) throw new Error(`unknown provider: ${provider}`);
    return slot;
  }

  private async registrationForAction(
    provider: Provider,
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
      const configuration = parseProviderApplicationConfiguration(snapshot.configurationSnapshot);
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
        registration,
        triggers: [],
        sourcesStarted: false,
        acceptingEvents: false,
      };
      return restored;
    } catch {
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

function actionNames(provider: Provider): readonly string[] {
  if (provider === "github") return ["start", "disconnect", "setup", "callback"];
  return ["start", "disconnect", "callback"];
}

function dynamicTrigger(provider: Provider, slot: Slot): TriggerProvider {
  const current = () => {
    const trigger = slot.active?.triggers[0];
    if (trigger === undefined) throw new Error(`${provider} trigger provider unavailable`);
    return trigger;
  };
  const snapshots = new WeakMap<object, TriggerProvider>();
  const remember = (value: unknown, snapshot: TriggerProvider) => {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      snapshots.set(value, snapshot);
    }
  };
  const providerFor = (value: unknown) =>
    (typeof value === "object" && value !== null ? snapshots.get(value) : undefined) ?? current();
  return {
    name: provider,
    eventNames: eventNames(provider),
    match: async (trigger) => {
      const snapshot = current();
      const result = await snapshot.match(trigger);
      if (typeof result !== "string") {
        for (const match of result) {
          remember(match.triggerContext, snapshot);
          remember(match.outputContext, snapshot);
        }
      }
      return result;
    },
    materializeLaunch: (input) =>
      providerFor(input.triggerContext).materializeLaunch?.(input) ?? Promise.resolve({}),
    materializeContext: (input) =>
      providerFor(input.triggerContext).materializeContext?.(input) ?? Promise.resolve(undefined),
    onDispatchAccepted: (...args) =>
      providerFor(args[0]).onDispatchAccepted?.(...args) ?? Promise.resolve(),
    onAgentExecutionStarted: (...args) =>
      providerFor(args[0]).onAgentExecutionStarted?.(...args) ?? Promise.resolve(),
    onAgentExecutionCompleted: (...args) =>
      providerFor(args[0]).onAgentExecutionCompleted?.(...args) ?? Promise.resolve(),
    onAgentExecutionFailed: (...args) =>
      providerFor(args[0]).onAgentExecutionFailed?.(...args) ?? Promise.resolve(),
    onAgentExecutionTerminal: (...args) =>
      providerFor(args[1]).onAgentExecutionTerminal?.(...args) ?? Promise.resolve(),
    onMachineTerminated: (...args) =>
      providerFor(args[0]).onMachineTerminated?.(...args) ?? Promise.resolve(),
  };
}

function eventNames(provider: Provider): TriggerProvider["eventNames"] {
  if (provider === "slack") return ["slack.mention"];
  if (provider === "discord") return ["discord.mention"];
  return [
    "github.issue_comment",
    "github.issues",
    "github.pull_request_review",
    "github.pull_request_review_comment",
    "github.push",
  ];
}

function dynamicGitHubConfiguration(slot: Slot): GitHubConfigurationProvider {
  const current = () => {
    const configuration = slot.active?.registration.githubConfiguration;
    if (configuration === undefined) throw new Error("github configuration unavailable");
    return configuration;
  };
  return {
    listInstallationRepositories: (input) => current().listInstallationRepositories(input),
    readDefaultBranchHead: (input) => current().readDefaultBranchHead(input),
    listFilesAtCommit: (input) => current().listFilesAtCommit(input),
    readFileAtCommit: (input) => current().readFileAtCommit(input),
  };
}

async function startSources(active: ActiveRegistration, handler: TriggerHandler): Promise<void> {
  if (active.sourcesStarted) return;
  const started: TriggerSource[] = [];
  try {
    for (const source of active.registration.sources) {
      await source.start((trigger) =>
        active.acceptingEvents ? handler(trigger) : Promise.resolve(),
      );
      started.push(source);
    }
    active.sourcesStarted = true;
  } catch (error) {
    await Promise.allSettled(started.toReversed().map((source) => source.stop()));
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

async function retire(provider: Provider, active: ActiveRegistration): Promise<void> {
  try {
    await stopSources(active);
  } catch (error) {
    logger.warn(
      { provider, errorType: error instanceof Error ? error.name : "UnknownError" },
      "retired provider resources failed to close",
    );
  }
}
