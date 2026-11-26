import { z } from "zod";
import type { IntegrationToolGrantBase } from "../integrations/browser-contracts.js";
import {
  defaultBrowserIntegrationRegistry,
  type IntegrationSchemaRegistry,
} from "../integrations/browser-registry.js";

export const integrationProviders = ["slack", "discord"] as const;
export type IntegrationProvider = (typeof integrationProviders)[number];
export const integrationActions = ["read", "post"] as const;
export type IntegrationAction = (typeof integrationActions)[number];
export const slackChannelId = z.string().regex(/^[CG][A-Z0-9]+$/u, "Use a Slack channel ID.");
export const discordId = z.string().regex(/^[1-9][0-9]{0,19}$/u, "Use a quoted Discord ID.");

function grantSchema(channelId: z.ZodString) {
  return z.strictObject({
    connection: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Use an integration slug."),
    actions: z.array(z.enum(integrationActions)).min(1).max(integrationActions.length),
    channels: z.array(channelId).min(1).max(50),
  });
}

const LegacyIntegrationToolGrantsSchema = z.strictObject({
  slack: grantSchema(slackChannelId).optional(),
  discord: grantSchema(discordId).optional(),
});

export type IntegrationToolGrant = NonNullable<
  z.infer<typeof LegacyIntegrationToolGrantsSchema>[IntegrationProvider]
>;

export interface IntegrationToolGrants {
  slack?: IntegrationToolGrant | undefined;
  discord?: IntegrationToolGrant | undefined;
  [provider: string]: IntegrationToolGrant | IntegrationToolGrantBase | undefined;
}

const grantsSchemaCache = new WeakMap<
  IntegrationSchemaRegistry,
  z.ZodType<IntegrationToolGrants>
>();
const compiledGrantsSchemaCache = new WeakMap<
  IntegrationSchemaRegistry,
  z.ZodType<IntegrationToolGrants>
>();

export function buildIntegrationToolGrantsSchema(
  registry: IntegrationSchemaRegistry = defaultBrowserIntegrationRegistry,
): z.ZodType<IntegrationToolGrants> {
  const cached = grantsSchemaCache.get(registry);
  if (cached !== undefined) return cached;
  const registeredShape: Record<string, z.ZodType<IntegrationToolGrantBase | undefined>> = {};
  const allProviders: string[] = [...integrationProviders];
  for (const integration of registry.withTools()) {
    registeredShape[integration.id] = integration.tools!.grantSchema.optional();
    allProviders.push(integration.id);
  }
  const built = LegacyIntegrationToolGrantsSchema.extend(registeredShape)
    .strict()
    .refine(
      (grants) => {
        const record: Record<string, unknown> = grants;
        return allProviders.some((provider) => record[provider] !== undefined);
      },
      {
        message: "Select at least one integration.",
      },
    );
  grantsSchemaCache.set(registry, built);
  return built;
}

export const IntegrationToolGrantsSchema: z.ZodType<IntegrationToolGrants> =
  buildIntegrationToolGrantsSchema();

export function normalizeIntegrationToolGrants(
  grants: IntegrationToolGrants,
  registry: IntegrationSchemaRegistry = defaultBrowserIntegrationRegistry,
): IntegrationToolGrants {
  const normalized: IntegrationToolGrants = {};
  for (const provider of integrationProviders) {
    const grant = grants[provider];
    if (grant === undefined) continue;
    normalized[provider] = {
      connection: grant.connection,
      actions: integrationActions.filter((action) => grant.actions.includes(action)),
      channels: [...new Set(grant.channels)].toSorted(),
    };
  }
  for (const integration of registry.withTools()) {
    const grant = grants[integration.id];
    if (grant === undefined) continue;
    normalized[integration.id] = integration.tools!.normalizeGrant(grant);
  }
  return normalized;
}

export function buildCompiledIntegrationToolGrantsSchema(
  registry: IntegrationSchemaRegistry = defaultBrowserIntegrationRegistry,
): z.ZodType<IntegrationToolGrants> {
  const cached = compiledGrantsSchemaCache.get(registry);
  if (cached !== undefined) return cached;
  const built = buildIntegrationToolGrantsSchema(registry).transform((grants) =>
    normalizeIntegrationToolGrants(grants, registry),
  );
  compiledGrantsSchemaCache.set(registry, built);
  return built;
}

export const CompiledIntegrationToolGrantsSchema: z.ZodType<IntegrationToolGrants> =
  buildCompiledIntegrationToolGrantsSchema();
