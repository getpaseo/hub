import { z } from "zod";

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

export const IntegrationToolGrantsSchema = z
  .strictObject({
    slack: grantSchema(slackChannelId).optional(),
    discord: grantSchema(discordId).optional(),
  })
  .refine((grants) => integrationProviders.some((provider) => grants[provider] !== undefined), {
    message: "Select at least one integration.",
  });

export type IntegrationToolGrants = z.infer<typeof IntegrationToolGrantsSchema>;
export type IntegrationToolGrant = NonNullable<IntegrationToolGrants[IntegrationProvider]>;

export function normalizeIntegrationToolGrants(
  grants: IntegrationToolGrants,
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
  return normalized;
}

export const CompiledIntegrationToolGrantsSchema = IntegrationToolGrantsSchema.transform(
  normalizeIntegrationToolGrants,
);
