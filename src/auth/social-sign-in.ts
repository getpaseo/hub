import type { GithubOptions, GoogleOptions, GoogleProfile } from "better-auth/social-providers";

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
  const google = readClient(environment, ENVIRONMENT_PREFIX.google);
  if (google !== undefined) signIn.google = { ...google, mapProfileToUser: googleEmailOwnership };
  const github = readClient(environment, ENVIRONMENT_PREFIX.github);
  if (github !== undefined) signIn.github = github;
  return signIn;
}

/**
 * Google vouches for an address only where it owns the mailbox: Gmail, or a Workspace domain,
 * which the `hd` claim names. Anywhere else `email_verified` can outlive a change of owner, so
 * Hub treats the address as unverified and never links it to an existing account.
 */
function googleEmailOwnership(profile: GoogleProfile): { emailVerified: boolean } {
  const ownedByGoogle =
    profile.email.toLowerCase().endsWith("@gmail.com") || profile.hd !== undefined;
  return { emailVerified: profile.email_verified && ownedByGoogle };
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
