import { z } from "zod";

export const integrationProviders = ["slack", "discord"] as const;
export type IntegrationProvider = (typeof integrationProviders)[number];
export const integrationActions = ["read", "post"] as const;
export type IntegrationAction = (typeof integrationActions)[number];
export const slackChannelId = z.string().regex(/^[CG][A-Z0-9]+$/u, "Use a Slack channel ID.");
export const discordId = z.string().regex(/^[1-9][0-9]{0,19}$/u, "Use a quoted Discord ID.");

function grant(channelId: z.ZodString) {
  return z.strictObject({
    connection: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Use an integration slug."),
    actions: z.array(z.enum(integrationActions)).min(1).max(integrationActions.length),
    channels: z.array(channelId).min(1).max(50),
  });
}

export const IntegrationToolGrantsSchema = z
  .strictObject({
    slack: grant(slackChannelId).optional(),
    discord: grant(discordId).optional(),
  })
  .refine((grants) => integrationProviders.some((provider) => grants[provider] !== undefined), {
    message: "Select at least one integration.",
  });

export type IntegrationToolGrants = z.infer<typeof IntegrationToolGrantsSchema>;
export type IntegrationToolGrant = NonNullable<IntegrationToolGrants[IntegrationProvider]>;
