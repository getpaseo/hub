import { z } from "zod";
export const configurationSchema = z.object({
  provider: z.literal("github"),
  appId: z.string().min(1),
  appSlug: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  privateKey: z.string().min(1),
  // Optional: an App without one has repository access and no event triggers.
  webhookSecret: z.string().min(1).optional(),
});
export interface GitHubProviderApplicationConfiguration {
  provider: "github";
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  /** Absent until the operator sets up event triggers, which need a public HTTPS address. */
  webhookSecret?: string;
  expectedVersion?: number;
}

export const identitySchema = z.object({
  provider: z.literal("github"),
  id: z.string().min(1),
  name: z.string().min(1),
  ownerLogin: z.string().min(1),
});

const surfaceSchema = z.enum(["appSetup", "apps"]).optional();
const expectedVersionSchema = z.number().int().positive().optional();
export const requestSchema = z.object({
  provider: z.literal("github"),
  appId: z.string().trim().min(1),
  appSlug: z.string().trim().min(1),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().min(1),
  privateKey: z.string().min(1),
  // Optional: event triggers need a public HTTPS address, repository access does not.
  webhookSecret: z.string().min(1).optional(),
  expectedVersion: expectedVersionSchema,
  surface: surfaceSchema,
});
export function normalizeRequest(
  data: z.infer<typeof requestSchema>,
): GitHubProviderApplicationConfiguration {
  return {
    provider: data.provider,
    appId: data.appId,
    appSlug: data.appSlug,
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    privateKey: data.privateKey,
    ...(data.webhookSecret === undefined ? {} : { webhookSecret: data.webhookSecret }),
    ...(data.expectedVersion === undefined ? {} : { expectedVersion: data.expectedVersion }),
  };
}
export function requestSecrets(data: z.infer<typeof requestSchema>): readonly string[] {
  return [
    data.clientSecret,
    data.privateKey,
    ...(data.webhookSecret === undefined ? [] : [data.webhookSecret]),
  ];
}

export type GitHubProviderApplicationIdentity = z.infer<typeof identitySchema>;
