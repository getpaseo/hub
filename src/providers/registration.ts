import type { ProjectConfigurationStore } from "../configuration/store.js";
import type { ConnectionResolutionContext, ConnectionResolver } from "../config/connections.js";
import type { OrganizationConnectionUsage } from "../db/types.js";
import type { OutputExecutor } from "../execution-capabilities/outputs.js";
import type { TriggerProvider, TriggerSource } from "../triggers/index.js";
import type { GitHubConfigurationProvider } from "../configuration/github-sync.js";

export interface TriggerProviderResources {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  connectionsForProject: (projectId: string) => ConnectionResolver;
}

export type TriggerProviderFactory = (
  resources: TriggerProviderResources,
) => TriggerProvider | undefined;

export interface ProviderIntegrationRegistration {
  resolve(
    projectId: string,
    connectionSlug: string,
    value: string,
    context?: ConnectionResolutionContext,
  ): Promise<string>;
  onExecutionTerminal?(executionId: string): Promise<void>;
}

export interface ProviderConnectionRegistration {
  name: string;
  status(connections: OrganizationConnectionUsage): unknown;
  actions: Readonly<Record<string, (request: Request) => Promise<Response>>>;
}

export interface ProviderOutputRegistration {
  type: string;
  execute: OutputExecutor;
}

export interface ProviderRequestRegistration {
  name: string;
  handle(request: Request): Promise<Response>;
}

export interface ProviderRegistration {
  connection: ProviderConnectionRegistration;
  integration?: ProviderIntegrationRegistration;
  triggerProviders: readonly TriggerProviderFactory[];
  sources: readonly TriggerSource[];
  outputs: readonly ProviderOutputRegistration[];
  requests: readonly ProviderRequestRegistration[];
  githubConfiguration?: GitHubConfigurationProvider;
}
