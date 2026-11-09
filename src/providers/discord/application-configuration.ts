import { z } from "zod";
export const configurationSchema = z.object({
  provider: z.literal("discord"),
  applicationId: z.string().min(1),
  clientSecret: z.string().min(1),
  botToken: z.string().min(1),
});
export interface DiscordProviderApplicationConfiguration {
  provider: "discord";
  applicationId: string;
  clientSecret: string;
  botToken: string;
  expectedVersion?: number;
}

export const identitySchema = z.object({
  provider: z.literal("discord"),
  id: z.string().min(1),
  name: z.string().min(1),
});

const surfaceSchema = z.enum(["appSetup", "apps"]).optional();
const expectedVersionSchema = z.number().int().positive().optional();
export const requestSchema = z.object({
  provider: z.literal("discord"),
  applicationId: z.string().trim().min(1),
  clientSecret: z.string().min(1),
  botToken: z.string().min(1),
  expectedVersion: expectedVersionSchema,
  surface: surfaceSchema,
});
export function normalizeRequest(
  data: z.infer<typeof requestSchema>,
): DiscordProviderApplicationConfiguration {
  return {
    provider: data.provider,
    applicationId: data.applicationId,
    clientSecret: data.clientSecret,
    botToken: data.botToken,
    ...(data.expectedVersion === undefined ? {} : { expectedVersion: data.expectedVersion }),
  };
}
export function requestSecrets(data: z.infer<typeof requestSchema>): readonly string[] {
  return [data.clientSecret, data.botToken];
}

export type DiscordProviderApplicationIdentity = z.infer<typeof identitySchema>;
