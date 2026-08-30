import type { AuthenticatedEnvelope } from "../../secrets/authenticated-envelope.js";
import {
  decryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import type { ForgejoAuthorityRegistration } from "../registration.js";
import {
  assertForgejoCapabilitySubset,
  assertForgejoRepositoriesEnrolled,
  assertForgejoRepositoriesInExecutionBoundary,
  ForgejoAuthorityError,
  forgejoDaemonEnvironment,
  type ForgejoExecutionScopeEvidence,
  type ForgejoPermissionLevel,
} from "../../config/forgejo-authority.js";

export type ForgejoConnectionLifecycle =
  | "pending_identity"
  | "active"
  | "degraded"
  | "disconnected";
export type ForgejoInstanceLifecycle =
  | "pending_verification"
  | "active"
  | "incompatible"
  | "unreachable"
  | "identity_drifted"
  | "revoked";
export type ForgejoCredentialLifecycle = "active" | "rotating" | "revoked";

export interface ForgejoAuthorityConnection {
  id: string;
  organizationId: string;
  slug: string;
  status: ForgejoConnectionLifecycle;
  forgejoUserId: number;
  forgejoUserLogin: string;
  instanceId: string;
}

export interface ForgejoAuthorityInstance {
  id: string;
  canonicalOrigin: string;
  status: ForgejoInstanceLifecycle;
}

export interface ForgejoAuthorityExecutionCredential {
  id: string;
  organizationId: string;
  kind: "execution";
  status: ForgejoCredentialLifecycle;
  envelope: AuthenticatedEnvelope;
  scopeEvidence: ForgejoExecutionScopeEvidence;
}

export interface ForgejoAuthoritySnapshot {
  connection: ForgejoAuthorityConnection;
  instance: ForgejoAuthorityInstance;
  enrolledRepositories: readonly string[];
  executionCredential: ForgejoAuthorityExecutionCredential | undefined;
}

export interface ForgejoExecutionAuthorityStore {
  loadSnapshot(input: {
    projectId: string;
    connectionSlug: string;
  }): Promise<ForgejoAuthoritySnapshot | undefined>;
}

export interface CreateForgejoExecutionAuthorityOptions {
  store: ForgejoExecutionAuthorityStore;
  keys: SecretEncryptionKeySource;
  now?: () => number;
}

export interface ForgejoMintedAuthority {
  token: string;
  expiresAt: number;
  origin: string;
  userId: number;
  login: string;
}

/**
 * T11 wiring seam. Integration owner attaches the returned registration onto
 * `ProviderRegistration.integration.forgejoAuthority` and
 * `createRuntimeExecutionAuthority` once connections exist.
 */
export function createForgejoAuthorityRegistration(
  options: CreateForgejoExecutionAuthorityOptions,
): ForgejoAuthorityRegistration & {
  mintGrant(input: {
    projectId: string;
    connectionSlug: string;
    repositories: readonly string[];
    contents: ForgejoPermissionLevel;
    issues: ForgejoPermissionLevel;
  }): Promise<ForgejoMintedAuthority>;
} {
  const now = options.now ?? Date.now;
  return {
    async mint(input) {
      const minted = await mintForgejoExecutionAuthority(options.store, options.keys, input, now);
      return {
        token: minted.token,
        expiresAt: minted.expiresAt,
        origin: minted.origin,
        userId: minted.userId,
        login: minted.login,
      };
    },
    async mintGrant(input) {
      return mintForgejoExecutionAuthority(options.store, options.keys, input, now);
    },
    async revoke() {
      // Persistent execution PATs are not deleted per run. T12 owns credential revoke.
    },
  };
}

export function revalidateForgejoExecutionGrant(input: {
  connectionSlug: string;
  repositories: readonly string[];
  contents: ForgejoPermissionLevel;
  issues: ForgejoPermissionLevel;
  snapshot: ForgejoAuthoritySnapshot | undefined;
}): {
  snapshot: ForgejoAuthoritySnapshot;
  credential: ForgejoAuthorityExecutionCredential;
} {
  const snapshot = input.snapshot;
  if (snapshot === undefined) {
    throw new ForgejoAuthorityError(
      "forgejo_connection_unavailable",
      `forgejo connection is unavailable: ${input.connectionSlug}`,
    );
  }
  if (snapshot.connection.slug !== input.connectionSlug) {
    throw new ForgejoAuthorityError(
      "forgejo_connection_unavailable",
      `forgejo connection is unavailable: ${input.connectionSlug}`,
    );
  }
  if (snapshot.connection.status !== "active") {
    throw new ForgejoAuthorityError(
      "forgejo_connection_unavailable",
      `forgejo connection is unavailable: ${input.connectionSlug}`,
    );
  }
  if (snapshot.instance.status !== "active") {
    throw new ForgejoAuthorityError(
      "forgejo_connection_unavailable",
      `forgejo connection is unavailable: ${input.connectionSlug}`,
    );
  }
  assertForgejoRepositoriesEnrolled(input.repositories, snapshot.enrolledRepositories);
  const credential = snapshot.executionCredential;
  if (
    credential === undefined ||
    credential.kind !== "execution" ||
    credential.status !== "active"
  ) {
    throw new ForgejoAuthorityError(
      "forgejo_credential_unavailable",
      "Forgejo execution credential is unavailable",
    );
  }
  assertForgejoRepositoriesInExecutionBoundary(input.repositories, credential.scopeEvidence);
  assertForgejoCapabilitySubset(
    { contents: input.contents, issues: input.issues },
    credential.scopeEvidence,
  );
  return { snapshot, credential };
}

export async function mintForgejoExecutionAuthority(
  store: ForgejoExecutionAuthorityStore,
  keys: SecretEncryptionKeySource,
  input: {
    projectId: string;
    connectionSlug: string;
    repositories: readonly string[];
    contents: ForgejoPermissionLevel;
    issues: ForgejoPermissionLevel;
  },
  now: () => number = Date.now,
): Promise<ForgejoMintedAuthority> {
  const loaded = await store.loadSnapshot({
    projectId: input.projectId,
    connectionSlug: input.connectionSlug,
  });
  const { snapshot, credential } = revalidateForgejoExecutionGrant({
    connectionSlug: input.connectionSlug,
    repositories: input.repositories,
    contents: input.contents,
    issues: input.issues,
    snapshot: loaded,
  });
  const token = decryptSecret(keys, credential.envelope, {
    organizationId: credential.organizationId,
    credentialId: credential.id,
    kind: "execution",
  });
  if (token.length === 0) {
    throw new ForgejoAuthorityError(
      "forgejo_credential_unavailable",
      "Forgejo execution credential is unavailable",
    );
  }
  return {
    token,
    expiresAt: now() + PERSISTENT_PAT_LEASE_HINT_MS,
    origin: snapshot.instance.canonicalOrigin,
    userId: snapshot.connection.forgejoUserId,
    login: snapshot.connection.forgejoUserLogin,
  };
}

export function injectForgejoDaemonEnvironment(
  minted: Pick<ForgejoMintedAuthority, "token" | "origin" | "userId" | "login">,
): Record<string, string> {
  return forgejoDaemonEnvironment(
    { origin: minted.origin, userId: minted.userId, login: minted.login },
    minted.token,
  );
}

const PERSISTENT_PAT_LEASE_HINT_MS = 60 * 60 * 1000;
