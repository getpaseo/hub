import type { AuthServer } from "../auth/server.js";
import type { Database } from "../db/types.js";
import type {
  ProviderApplicationConfiguration,
  ProviderApplicationIdentity,
  ProviderApplicationResult,
  ProviderApplicationSaveResult,
} from "../provider-applications/index.js";
import type { ProviderApplicationContext } from "../provider-applications/workflow.js";
import type { TriggerProvider } from "../triggers/index.js";
import type { SlackDeliveryStatus } from "../triggers/slack/source/index.js";
import type { ProviderRegistration } from "./registration.js";

export interface ProviderManifest {
  id: string;
  connectionOrder?: number;
  actions: readonly string[];
  events: TriggerProvider["eventNames"];
  requests: readonly string[];
  outputs: readonly Pick<ProviderRegistration["outputs"][number], "type" | "tool">[];
  integration?: { repositoryAuthority?: true };
  attachment?: NonNullable<ProviderRegistration["attachment"]>["provider"];
}

export interface ProviderRuntimeInput {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  fetch?: typeof fetch;
  configuration: unknown;
  callbackOrigin: string;
  configurationVersion: number;
  expectedConfigurationVersion: number | undefined;
  activateConfiguration: boolean;
  onInstallation(operation: ProviderInstallation): Promise<void>;
}

export interface ProviderVerificationOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface ProviderApplication {
  persistence(
    database: import("../db/runtime/index.js").DatabaseRuntime,
  ): import("../provider-applications/connection-persistence.js").ProviderConnectionInventory;
  parseConfiguration(value: unknown): ProviderApplicationConfiguration;
  parseIdentity(value: unknown): ProviderApplicationIdentity;
  readEnvironment(
    environment: Record<string, string | undefined>,
  ):
    | Promise<ProviderApplicationConfiguration | undefined>
    | ProviderApplicationConfiguration
    | undefined;
  identifiers(configuration: ProviderApplicationConfiguration): Readonly<Record<string, string>>;
  acceptsEvents(configuration: ProviderApplicationConfiguration): boolean;
  receivesEvents: boolean;
  connectionRequiresHttps?: boolean;
  verify?(
    configuration: ProviderApplicationConfiguration,
    options: ProviderVerificationOptions,
  ): Promise<ProviderApplicationIdentity>;
  environmentIdentity?(
    configuration: ProviderApplicationConfiguration,
  ): ProviderApplicationIdentity;
  configure?(
    context: ProviderApplicationContext,
    input: ProviderApplicationConfiguration,
  ): Promise<ProviderApplicationSaveResult>;
  deliveryStatus?(
    options: import("../provider-applications/index.js").ProviderApplicationsOptions,
  ): SlackDeliveryStatus | undefined;
  activationError?(error: unknown): Error | undefined;
  socket?: {
    configure(
      context: Pick<ProviderApplicationContext, "options" | "request" | "account">,
      input: { appToken: string; botToken: string; expectedVersion?: number },
    ): Promise<ProviderApplicationResult>;
  };
}

export interface ProviderModule {
  summarizeEvent(payload: unknown): import("./presentation.js").ProviderEventSummary;
  manifest: ProviderManifest;
  application: ProviderApplication;
  createRuntime(input: ProviderRuntimeInput): ProviderRegistration;
}

export class ProviderRegistry {
  private readonly modules = new Map<string, ProviderModule>();

  constructor(modules: readonly ProviderModule[]) {
    for (const module of modules) {
      const id = module.manifest.id;
      if (!/^[a-z][a-z0-9_-]*$/u.test(id)) throw new Error(`invalid provider id: ${id}`);
      if (this.modules.has(id)) throw new Error(`provider already registered: ${id}`);
      this.modules.set(id, module);
    }
  }

  list(): readonly ProviderModule[] {
    return [...this.modules.values()];
  }

  require(id: string): ProviderModule {
    const module = this.modules.get(id);
    if (module === undefined) throw new Error(`unknown provider: ${id}`);
    return module;
  }

  parseConfiguration(value: unknown): ProviderApplicationConfiguration {
    if (
      value === null ||
      typeof value !== "object" ||
      !("provider" in value) ||
      typeof value.provider !== "string"
    ) {
      throw new Error("invalid provider configuration");
    }
    return this.require(value.provider).application.parseConfiguration(value);
  }
}

export type ProviderInstallation = (
  options: import("../provider-applications/index.js").ProviderApplicationsOptions,
) => Promise<void>;
