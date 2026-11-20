import { integrationTools } from "./contracts.js";
import type { IntegrationProvider, IntegrationToolGrants } from "./grants.js";
import { IntegrationToolError, type IntegrationToolHandler } from "./http.js";

export { createDiscordIntegrationTools } from "./discord.js";
export { createSlackIntegrationTools } from "./slack.js";
export {
  IntegrationToolError,
  type IntegrationToolCall,
  type IntegrationToolHandler,
} from "./http.js";

export type IntegrationToolHandlers = Partial<Record<IntegrationProvider, IntegrationToolHandler>>;

function grantedTools(grants: IntegrationToolGrants | undefined) {
  return integrationTools.filter(({ provider, action }) =>
    grants?.[provider]?.actions.includes(action),
  );
}

export function integrationToolDefinitions(grants: IntegrationToolGrants | undefined) {
  return grantedTools(grants).map(({ definition }) => definition);
}

export async function callIntegrationTool(input: {
  name: string;
  organizationId: string;
  grants: IntegrationToolGrants | undefined;
  handlers?: IntegrationToolHandlers | undefined;
  args: Record<string, unknown>;
}): Promise<{ value: unknown } | undefined> {
  const tool = grantedTools(input.grants).find(({ definition }) => definition.name === input.name);
  if (tool === undefined) return undefined;
  const handler = input.handlers?.[tool.provider];
  const grant = input.grants?.[tool.provider];
  if (handler === undefined || grant === undefined) {
    throw new IntegrationToolError("The integration is unavailable.");
  }
  if (!tool.schema.safeParse(input.args).success) {
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
