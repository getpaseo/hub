import { z } from "zod";
export const configurationSchema = z.discriminatedUnion("transport", [
  z.object({
    provider: z.literal("slack"),
    transport: z.literal("socket"),
    appId: z.string().min(1),
    appToken: z.string().min(1),
  }),
  z.object({
    provider: z.literal("slack"),
    transport: z.literal("webhook"),
    appId: z.string().min(1),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    signingSecret: z.string().min(1),
  }),
]);
export type SlackProviderApplicationConfiguration =
  | {
      provider: "slack";
      transport: "socket";
      appId: string;
      appToken: string;
      expectedVersion?: number;
    }
  | {
      provider: "slack";
      transport: "webhook";
      appId: string;
      clientId: string;
      clientSecret: string;
      signingSecret: string;
      expectedVersion?: number;
    };

export const identitySchema = z.object({
  provider: z.literal("slack"),
  id: z.string().min(1),
  name: z.string().min(1),
});

const surfaceSchema = z.enum(["appSetup", "apps"]).optional();
const expectedVersionSchema = z.number().int().positive().optional();
export const requestSchema = z.object({
  provider: z.literal("slack"),
  transport: z.literal("webhook"),
  appId: z.string().trim().min(1),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().min(1),
  signingSecret: z.string().min(1),
  expectedVersion: expectedVersionSchema,
  surface: surfaceSchema,
});
export function normalizeRequest(
  data: z.infer<typeof requestSchema>,
): SlackProviderApplicationConfiguration {
  return {
    provider: data.provider,
    transport: data.transport,
    appId: data.appId,
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    signingSecret: data.signingSecret,
    ...(data.expectedVersion === undefined ? {} : { expectedVersion: data.expectedVersion }),
  };
}
export function requestSecrets(data: z.infer<typeof requestSchema>): readonly string[] {
  return [data.clientSecret, data.signingSecret];
}

export type SlackProviderApplicationIdentity = z.infer<typeof identitySchema>;
