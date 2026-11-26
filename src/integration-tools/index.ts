import type { IntegrationToolGrantBase } from "../integrations/contracts.js";
import { defaultIntegrationRegistry, type IntegrationRegistry } from "../integrations/registry.js";
import { integrationTools } from "./contracts.js";
import type { IntegrationToolGrants } from "./grants.js";
import { IntegrationToolError, type IntegrationToolHandler } from "./http.js";

export { createDiscordIntegrationTools } from "./discord.js";
export { createSlackIntegrationTools } from "./slack.js";
export {
  IntegrationToolError,
  type IntegrationToolCall,
  type IntegrationToolHandler,
} from "./http.js";

export interface IntegrationToolHandlers {
  slack?: IntegrationToolHandler | undefined;
  discord?: IntegrationToolHandler | undefined;
  registered?:
    | Readonly<Record<string, IntegrationToolHandler<IntegrationToolGrantBase>>>
    | undefined;
}

function grantedLegacyTools(grants: IntegrationToolGrants | undefined) {
  return integrationTools.filter(({ provider, action }) =>
    grants?.[provider]?.actions.includes(action),
  );
}

function grantedRegisteredTools(
  grants: IntegrationToolGrants | undefined,
  registry: IntegrationRegistry,
) {
  return registry.withTools().flatMap((integration) => {
    const grant = grants?.[integration.id];
    if (grant === undefined) return [];
    const actions: readonly string[] = grant.actions;
    return integration
      .tools!.tools.filter((spec) => actions.includes(spec.action))
      .map((spec) => ({
        provider: integration.id,
        action: spec.action,
        schema: spec.schema,
        definition: spec.definition,
      }));
  });
}

export function integrationToolDefinitions(
  grants: IntegrationToolGrants | undefined,
  registry: IntegrationRegistry = defaultIntegrationRegistry,
) {
  return [
    ...grantedLegacyTools(grants).map(({ definition }) => definition),
    ...grantedRegisteredTools(grants, registry).map(({ definition }) => definition),
  ];
}

export async function callIntegrationTool(input: {
  name: string;
  organizationId: string;
  grants: IntegrationToolGrants | undefined;
  handlers?: IntegrationToolHandlers | undefined;
  args: Record<string, unknown>;
  registry?: IntegrationRegistry;
}): Promise<{ value: unknown } | undefined> {
  const legacyTool = grantedLegacyTools(input.grants).find(
    ({ definition }) => definition.name === input.name,
  );
  if (legacyTool !== undefined) {
    const handler = input.handlers?.[legacyTool.provider];
    const grant = input.grants?.[legacyTool.provider];
    if (handler === undefined || grant === undefined) {
      throw new IntegrationToolError("The integration is unavailable.");
    }
    if (!legacyTool.schema.safeParse(input.args).success) {
      throw new IntegrationToolError(
        "Invalid arguments for the integration tool. Check its input schema.",
      );
    }
    return {
      value: await handler({
        name: input.name,
        organizationId: input.organizationId,
        grant,
        args: input.args,
      }),
    };
  }

  const registry = input.registry ?? defaultIntegrationRegistry;
  const registeredTool = grantedRegisteredTools(input.grants, registry).find(
    ({ definition }) => definition.name === input.name,
  );
  if (registeredTool === undefined) return undefined;
  const handler = input.handlers?.registered?.[registeredTool.provider];
  const grant = input.grants?.[registeredTool.provider];
  if (handler === undefined || grant === undefined) {
    throw new IntegrationToolError("The integration is unavailable.");
  }
  if (!registeredTool.schema.safeParse(input.args).success) {
    throw new IntegrationToolError(
      "Invalid arguments for the integration tool. Check its input schema.",
    );
  }
  return {
    value: await handler({
      name: input.name,
      organizationId: input.organizationId,
      grant,
      args: input.args,
    }),
  };
}
