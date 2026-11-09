import {
  ProviderApplicationError,
  type ProviderApplicationConfiguration,
  type ProviderApplications,
  type ProviderApplicationView,
  type ProviderRuntimeOwner,
} from "../../provider-applications/index.js";
import type { ProviderApplicationContext } from "../../provider-applications/workflow.js";
import type { ProviderApplication, ProviderRegistry } from "../registry.js";
import { configurationSchema, identitySchema } from "./application-configuration.js";
import { connectionInventory } from "./application-persistence.js";
import { beginSlackConfiguration } from "./application.js";
import { readEnvironment } from "./environment.js";
import {
  createSlackSocketInstallationVerifier,
  type SlackSocketInstallationVerifier,
} from "./installation.js";
import { slackDelivery } from "./runtime.js";
import { configureSocket } from "./socket-application.js";

export interface SlackSocketConfiguration {
  appToken: string;
  botToken: string;
  expectedVersion?: number;
}

export class SlackApplication implements ProviderApplication {
  persistence = connectionInventory;
  readEnvironment = readEnvironment;
  receivesEvents = true;

  constructor(
    private readonly verifier: SlackSocketInstallationVerifier = createSlackSocketInstallationVerifier(),
  ) {}

  parseConfiguration(value: unknown) {
    return configurationSchema.parse(value);
  }
  parseIdentity(value: unknown) {
    return identitySchema.parse(value);
  }
  identifiers(value: ProviderApplicationConfiguration) {
    const configuration = configurationSchema.parse(value);
    return configuration.transport === "webhook"
      ? {
          appId: configuration.appId,
          transport: configuration.transport,
          clientId: configuration.clientId,
        }
      : { appId: configuration.appId, transport: configuration.transport };
  }
  acceptsEvents(_value: ProviderApplicationConfiguration) {
    return true;
  }
  environmentIdentity(value: ProviderApplicationConfiguration) {
    const configuration = configurationSchema.parse(value);
    return { provider: "slack" as const, id: configuration.appId, name: "Slack app" };
  }
  configure(context: ProviderApplicationContext, value: ProviderApplicationConfiguration) {
    const configuration = this.parseConfiguration(value);
    return beginSlackConfiguration(
      context.options,
      context.request,
      context.account,
      context.callbackOrigin,
      {
        ...configuration,
        ...(value.expectedVersion === undefined ? {} : { expectedVersion: value.expectedVersion }),
      },
      context.returnRoute,
    );
  }
  configureSocket(
    context: Pick<ProviderApplicationContext, "options" | "request" | "account">,
    input: SlackSocketConfiguration,
  ) {
    return configureSocket(context, input, this.verifier);
  }
  projectView(view: ProviderApplicationView, runtime: ProviderRuntimeOwner) {
    return { ...view, deliveryStatus: slackDelivery(runtime).status() };
  }
}

interface SlackSocketApplication {
  configureSocket(
    context: Pick<ProviderApplicationContext, "options" | "request" | "account">,
    input: SlackSocketConfiguration,
  ): ReturnType<typeof configureSocket>;
}
function isSlackSocketApplication(
  application: ProviderApplication,
): application is ProviderApplication & SlackSocketApplication {
  return "configureSocket" in application && typeof application.configureSocket === "function";
}
function slackApplication(registry: ProviderRegistry): SlackSocketApplication {
  const application = registry.require("slack").application;
  if (!isSlackSocketApplication(application))
    throw new Error("Slack application capability unavailable");
  return application;
}

export function configureSlackSocket(
  applications: ProviderApplications,
  request: Request,
  input: SlackSocketConfiguration,
) {
  return applications.withOperator(request, (context) => {
    if (context.options.environment["slack"] !== undefined)
      throw new ProviderApplicationError("managedByEnvironment");
    const application = slackApplication(context.options.registry);
    return context.serialize("slack", () => application.configureSocket(context, input));
  });
}

export function retrySlackSocket(
  applications: ProviderApplications,
  request: Request,
): Promise<void> {
  return applications.withOperator(request, (context) =>
    slackDelivery(context.options.runtime).retry(),
  );
}
