import { z } from "zod";
export const configurationSchema = z.object({
  provider: z.literal("linear"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  webhookSecret: z.string().min(1),
});
export interface LinearProviderApplicationConfiguration {
  provider: "linear";
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  expectedVersion?: number;
}

export const identitySchema = z.object({
  provider: z.literal("linear"),
  id: z.string().min(1),
  name: z.string().min(1),
});

const surfaceSchema = z.enum(["appSetup", "apps"]).optional();
const expectedVersionSchema = z.number().int().positive().optional();
export const requestSchema = z.object({
  provider: z.literal("linear"),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().min(1),
  webhookSecret: z.string().min(1),
  expectedVersion: expectedVersionSchema,
  surface: surfaceSchema,
});
export function normalizeRequest(
  data: z.infer<typeof requestSchema>,
): LinearProviderApplicationConfiguration {
  return {
    provider: data.provider,
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    webhookSecret: data.webhookSecret,
    ...(data.expectedVersion === undefined ? {} : { expectedVersion: data.expectedVersion }),
  };
}
export function requestSecrets(data: z.infer<typeof requestSchema>): readonly string[] {
  return [data.clientSecret, data.webhookSecret];
}

export type LinearProviderApplicationIdentity = z.infer<typeof identitySchema>;
