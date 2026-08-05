import { createHubApplication } from "./app.js";
import type { AuthServer } from "./auth/server.js";
import type { OperationAuthenticator } from "./auth/operation-auth.js";
import type { ConnectionResolutionContext, ConnectionResolver } from "./config/interpolation.js";
import type { Database } from "./db/types.js";
import { resolveRouteTenant } from "./projects/access.js";
import type { DaemonDispatchLifecycleOptions } from "./daemons/lifecycle.js";
import { OrganizationResources } from "./organizations/resources.js";
import { OutputExecutorRegistry } from "./execution-capabilities/outputs.js";
import type {
  ProviderIntegrationRegistration,
  ProviderRegistration,
} from "./providers/registration.js";
import type { ApplicationRuntime } from "./server/runtime.js";
import { ProjectDashboard } from "./projects/dashboard.js";

export interface ApplicationCompositionOptions {
  database: Database | null;
  auth: AuthServer | null;
  operationAuth?: OperationAuthenticator;
  registrations?: readonly ProviderRegistration[];
  publicBaseUrl?: string;
  completionTokenSecret?: string;
  testTriggerRoutes?: boolean;
  daemonConnectionForId?: DaemonDispatchLifecycleOptions["connectionForDaemon"];
  close(): Promise<void>;
}

export async function createApplicationRuntime(
  options: ApplicationCompositionOptions,
): Promise<ApplicationRuntime> {
  const registrations = options.registrations ?? [];
  const connections = new Map(
    registrations.map((registration) => [registration.connection.name, registration.connection]),
  );
  if (connections.size !== registrations.length) {
    throw new Error("provider connection registrations must have unique names");
  }
  const integrations = new Map<string, ProviderIntegrationRegistration>();
  for (const registration of registrations) {
    if (registration.integration !== undefined) {
      integrations.set(registration.connection.name, registration.integration);
    }
  }
  const connectionsForProject =
    (projectId: string): ConnectionResolver =>
    async (connectionSlug, value, context?: ConnectionResolutionContext) => {
      if (options.database === null) throw new Error("connection inventory unavailable");
      const project = await options.database.findProjectById(projectId);
      if (project === undefined) throw new Error("execution project unavailable");
      const usage = await options.database.organizationConnectionUsage(project.organizationId);
      const candidates = [
        ...usage.github.map((connection) => ({ provider: "github" as const, connection })),
        ...usage.discord.map((connection) => ({ provider: "discord" as const, connection })),
        ...usage.slack.map((connection) => ({ provider: "slack" as const, connection })),
      ].filter(({ connection }) => connection.slug === connectionSlug);
      if (candidates.length === 0) {
        throw new Error(`connection slug is unavailable: ${connectionSlug}`);
      }
      if (candidates.length !== 1) {
        throw new Error(`connection slug is ambiguous: ${connectionSlug}`);
      }
      const integration = integrations.get(candidates[0]!.provider);
      if (integration === undefined) {
        throw new Error(`connection capability is unavailable: ${connectionSlug}`);
      }
      return integration.resolve(projectId, connectionSlug, value, context);
    };
  const outputRegistry = new OutputExecutorRegistry();
  for (const output of registrations.flatMap((registration) => registration.outputs)) {
    outputRegistry.register(output.type, output.execute);
  }

  const application = createHubApplication({
    database: options.database,
    providerFactories: registrations.flatMap((registration) => registration.triggerProviders),
    integrations: [...integrations.values()],
    attachmentResolvers: Object.fromEntries(
      registrations.flatMap((registration) =>
        registration.attachment === undefined
          ? []
          : [[registration.attachment.provider, registration.attachment.resolve] as const],
      ),
    ),
    connectionsForProject,
    ...(options.auth === null ? {} : { browserOrganizationAccess: options.auth }),
    ...(options.operationAuth === undefined ? {} : { operationAuth: options.operationAuth }),
    ...(options.publicBaseUrl === undefined ? {} : { publicBaseUrl: options.publicBaseUrl }),
    ...(options.completionTokenSecret === undefined
      ? {}
      : { completionTokenSecret: options.completionTokenSecret }),
    outputRegistry,
    ...(options.daemonConnectionForId === undefined
      ? {}
      : { daemonConnectionForId: options.daemonConnectionForId }),
  });
  await application.hub.start(registrations.flatMap((registration) => registration.sources));

  const resources = options.database === null ? null : new OrganizationResources(options.database);
  const requests = new Map<string, (incoming: Request) => Promise<Response>>();
  for (const request of registrations.flatMap((registration) => registration.requests)) {
    if (requests.has(request.name)) {
      throw new Error(`provider request registrations must have unique names: ${request.name}`);
    }
    requests.set(request.name, (incoming) => request.handle(incoming));
  }
  const activeHub = application.hub;
  const githubConfigurations = registrations.flatMap((registration) =>
    registration.githubConfiguration === undefined ? [] : [registration.githubConfiguration],
  );
  if (githubConfigurations.length > 1) {
    throw new Error("GitHub configuration registrations must be unique");
  }
  return {
    hub: activeHub,
    operations: application.operations,
    resources,
    projectDashboard:
      options.database === null || options.auth === null
        ? null
        : new ProjectDashboard(options.database, options.auth, githubConfigurations[0]),
    testTriggerRoutes: options.testTriggerRoutes ?? false,
    auth: (request) => {
      if (options.database === null) {
        return Promise.resolve(Response.json({ error: "database_unavailable" }, { status: 503 }));
      }
      return options.auth === null
        ? Promise.resolve(Response.json({ error: "auth_unavailable" }, { status: 503 }))
        : options.auth.handle(request);
    },
    browserAccount: (request) => {
      if (options.database === null || options.auth?.browserAccount === undefined) {
        return Promise.resolve(Response.json({ error: "auth_unavailable" }, { status: 503 }));
      }
      return options.auth.browserAccount(request);
    },
    signInEmail(data, headers) {
      if (options.database === null || options.auth?.signInEmail === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.signInEmail(data, headers);
    },
    signUpEmail(data, headers, invitationId) {
      if (options.database === null || options.auth?.signUpEmail === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.signUpEmail(data, headers, invitationId);
    },
    signOut(headers) {
      if (options.database === null || options.auth?.signOut === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.signOut(headers);
    },
    changePassword(data, headers) {
      if (options.database === null || options.auth?.changePassword === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.changePassword(data, headers);
    },
    organizationResources(request) {
      if (resources === null || options.auth === null) {
        return Promise.reject(new Error("organization resources are unavailable"));
      }
      return options.auth.resources(request, resources);
    },
    connectionStatus: async (request) => {
      if (options.database === null || options.auth === null) {
        return Response.json({ error: "database_unavailable" }, { status: 503 });
      }
      try {
        const url = new URL(request.url);
        const organizationSlug = url.searchParams.get("organizationSlug");
        if (organizationSlug === null) {
          return Response.json({ error: "organization_required" }, { status: 400 });
        }
        const { tenant } = await resolveRouteTenant(options.auth, options.database, request, {
          organizationSlug,
        });
        const bindings = await options.database.organizationConnectionUsage(tenant.organization.id);
        const statuses = Object.fromEntries(
          [...connections.values()].map((connection) => [
            connection.name,
            connection.status(bindings),
          ]),
        );
        return Response.json({
          canManage: tenant.membership.role !== "member",
          ...statuses,
        });
      } catch {
        return Response.json({ error: "connection_status_unavailable" }, { status: 503 });
      }
    },
    connectionAction: (request, provider, action) => {
      if (options.database === null || options.auth === null) {
        return Promise.resolve(Response.json({ error: "database_unavailable" }, { status: 503 }));
      }
      return (
        connections.get(provider)?.actions[action]?.(request) ??
        Promise.resolve(Response.json({ error: "provider_not_configured" }, { status: 409 }))
      );
    },
    webhook: (request) =>
      requests.get("webhook")?.(request) ??
      Promise.resolve(new Response("Not Found", { status: 404 })),
    providerRequest: (name, request) =>
      requests.get(name)?.(request) ?? Promise.resolve(new Response("Not Found", { status: 404 })),
    async stop() {
      await activeHub.stop();
      await options.close();
    },
  };
}
