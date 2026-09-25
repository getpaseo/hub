/**
 * A credential the authority must revoke when the execution ends. GitHub only: a
 * lease promises a working revoke, which a minted installation token has and a
 * Forgejo token doesn't, so Forgejo resolves its token without registering one.
 */
export interface ConnectionTokenLease {
  provider: "github";
  token: string;
  expiresAt: number;
}

export interface ConnectionResolutionContext {
  executionId?: string;
  registerToken?: (lease: ConnectionTokenLease) => Promise<void> | void;
}

export type ConnectionResolver = (
  connectionSlug: string,
  value: string,
  context?: ConnectionResolutionContext,
) => Promise<string> | string;
