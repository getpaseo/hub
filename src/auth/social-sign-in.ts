import type { GithubOptions, GoogleOptions } from "better-auth/social-providers";

export const SOCIAL_PROVIDERS = ["google", "github"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/**
 * The identity providers this Hub signs people in with, each in Better Auth's own option shape.
 * A provider that is absent is off: no button, no callback route.
 */
export interface SocialSignIn {
  google?: GoogleOptions;
  github?: GithubOptions;
}

const ENVIRONMENT_PREFIX: Record<SocialProvider, string> = {
  google: "PASEO_AUTH_GOOGLE",
  github: "PASEO_AUTH_GITHUB",
};

/**
 * Reads each provider's OAuth client from the environment. Both halves of a client or neither:
 * a client id without its secret would put a button on the sign-in card that can never work.
 */
export function readSocialSignIn(environment: Record<string, string | undefined>): SocialSignIn {
  const signIn: SocialSignIn = {};
  for (const provider of SOCIAL_PROVIDERS) {
    const client = readClient(environment, ENVIRONMENT_PREFIX[provider]);
    if (client !== undefined) signIn[provider] = client;
  }
  return signIn;
}

export function configuredSocialProviders(signIn: SocialSignIn): SocialProvider[] {
  return SOCIAL_PROVIDERS.filter((provider) => signIn[provider] !== undefined);
}

function readClient(
  environment: Record<string, string | undefined>,
  prefix: string,
): { clientId: string; clientSecret: string } | undefined {
  const idName = `${prefix}_CLIENT_ID`;
  const secretName = `${prefix}_CLIENT_SECRET`;
  const clientId = environment[idName]?.trim() ?? "";
  const clientSecret = environment[secretName]?.trim() ?? "";
  if (clientId.length === 0 && clientSecret.length === 0) return undefined;
  if (clientId.length === 0 || clientSecret.length === 0) {
    throw new Error(`${idName} and ${secretName} must be supplied together`);
  }
  return { clientId, clientSecret };
}
