import { randomBytes, randomUUID } from "node:crypto";
import {
  FORGEJO_PAT_SCOPES,
  forgejoScopeCovers,
  normalizeForgejoRepositoryName,
} from "../../config/forgejo-authority.js";
import type {
  Database,
  ForgejoConnectionRecord,
  ForgejoRepositoryHookRecord,
  ForgejoRepositoryRecord,
} from "../../db/types.js";
import {
  decryptSecret,
  encryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import { reconcileForgejoManagedHookSecret, removeForgejoManagedHook } from "./hooks.js";
import {
  ForgejoContractError,
  originFromInstance,
  type ForgejoCredentialKind,
  type ForgejoCredentialState,
  type ForgejoDirectory,
  type ForgejoHttp,
  type ForgejoStoredExecutionCredentialRecord,
  type ForgejoWebhookSecretRecord,
} from "./instances.js";

const WORKFLOW_SCAN_LIMIT = 1_000;
const REPOSITORY_FULL_NAME = /^[^/\s]+\/[^/\s]+$/u;

export interface ForgejoCredentialLifecycleView {
  kind: ForgejoCredentialKind;
  keyId: number;
  status: ForgejoCredentialState["status"];
  rotatedAt: string | null;
}

export interface ForgejoLifecycleRepositoryImpact {
  repositoryId: number;
  fullName: string;
  enrolled: boolean;
}

export interface ForgejoLifecycleHookImpact {
  repositoryId: number;
  fullName: string | null;
  managed: boolean;
  status: ForgejoRepositoryHookRecord["status"];
}

export interface ForgejoLifecycleConfigurationImpact {
  projectId: string;
  repositoryId: number;
  activeRevisionId: string | null;
}

export interface ForgejoLifecycleRouteImpact {
  projectId: string;
  repositoryId: number;
  configurationRevisionId: string;
}

export interface ForgejoLifecycleWorkImpact {
  projectId: string;
  configurationRevisionId: string;
  triggerRunId: string;
  stepRunId: string;
}

export interface ForgejoDisconnectImpact {
  connectionId: string;
  repositories: ForgejoLifecycleRepositoryImpact[];
  hooks: ForgejoLifecycleHookImpact[];
  configurationSources: ForgejoLifecycleConfigurationImpact[];
  activeRevisions: { projectId: string; revisionId: string }[];
  triggerRoutes: ForgejoLifecycleRouteImpact[];
  hydrationSignals: { repositoryId: number; effect: "future_hydration_disabled" }[];
  work: {
    queued: ForgejoLifecycleWorkImpact[];
    inFlight: ForgejoLifecycleWorkImpact[];
    queuedEffect: "revalidates_before_execution";
    inFlightEffect: "already_minted_authority_is_not_recalled";
  };
  futureExecution: "blocked";
}

export interface ForgejoLifecycleImpactSource {
  describe(input: {
    organizationId: string;
    connectionId: string;
    repositories: readonly ForgejoRepositoryRecord[];
  }): Promise<{
    configurationSources: ForgejoLifecycleConfigurationImpact[];
    activeRevisions: { projectId: string; revisionId: string }[];
    triggerRoutes: ForgejoLifecycleRouteImpact[];
    work: ForgejoDisconnectImpact["work"];
  }>;
}

export interface ForgejoHookReconciliationResult {
  repositoryId: number;
  fullName: string;
  result: "reconciled" | "pending";
}

export interface ForgejoWebhookSecretRotationResult {
  credential: ForgejoCredentialLifecycleView;
  cutover: "complete" | "pending";
  hooks: ForgejoHookReconciliationResult[];
}

export interface ForgejoRemoteCleanupResult {
  repositoryId: number;
  fullName: string | null;
  managed: boolean;
  result: "removed" | "preserved_manual" | "pending";
}

export interface ForgejoDisconnectResult {
  disconnected: true;
  impact: ForgejoDisconnectImpact;
  cleanupStatus: "complete" | "REMOTE_CLEANUP_PENDING";
  cleanup: ForgejoRemoteCleanupResult[];
}

export interface ForgejoLifecycle {
  previewDisconnect(input: {
    organizationId: string;
    connectionId: string;
  }): Promise<ForgejoDisconnectImpact>;
  rotateConnectionCredential(input: {
    organizationId: string;
    connectionId: string;
    pat: string;
    scopes: readonly string[];
    repositoryIds: readonly number[];
  }): Promise<ForgejoCredentialLifecycleView>;
  configureExecutionCredential(input: {
    organizationId: string;
    connectionId: string;
    pat: string;
    scopes: readonly string[];
    repositories: readonly string[];
  }): Promise<ForgejoCredentialLifecycleView>;
  revokeExecutionCredential(input: {
    organizationId: string;
    connectionId: string;
  }): Promise<ForgejoCredentialLifecycleView>;
  revokeConnectionCredential(input: {
    organizationId: string;
    connectionId: string;
  }): Promise<ForgejoCredentialLifecycleView>;
  rotateWebhookSecret(input: {
    organizationId: string;
    connectionId: string;
    webhookAdminPat: string;
  }): Promise<ForgejoWebhookSecretRotationResult>;
  disconnect(input: {
    organizationId: string;
    connectionId: string;
    webhookAdminPat?: string;
  }): Promise<ForgejoDisconnectResult>;
}

export function createForgejoLifecycle(options: {
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
  impactSource?: ForgejoLifecycleImpactSource;
  now?: () => Date;
}): ForgejoLifecycle {
  const now = options.now ?? (() => new Date());
  const impactSource = options.impactSource ?? emptyImpactSource;
  return {
    previewDisconnect: async (input) =>
      previewDisconnect({
        directory: options.directory,
        impactSource,
        organizationId: input.organizationId,
        connectionId: input.connectionId,
      }),
    rotateConnectionCredential: async (input) => {
      const connection = await requireOwnedUsableConnection(options.directory, input);
      const previous = await options.directory.findActiveConnectionCredential(connection.id);
      if (previous === undefined) throw credentialUnavailable();
      const timestamp = now();
      const id = randomUUID();
      const envelope = encryptSecret(options.secrets, {
        plaintext: input.pat,
        organizationId: connection.organizationId,
        credentialId: id,
        kind: "connection",
      });
      await options.directory.replaceActiveCredential({
        previousCredentialId: previous.id,
        previousStatus: "revoked",
        rotatedAt: timestamp,
        next: {
          id,
          organizationId: connection.organizationId,
          connectionId: connection.id,
          kind: "connection",
          alg: envelope.alg,
          keyId: envelope.keyId,
          nonce: envelope.nonce,
          ciphertext: envelope.ciphertext,
          aadVersion: envelope.aadVersion,
          scopeEvidence: {
            scopes: [...input.scopes],
            repositoryIds: [...input.repositoryIds],
          },
          status: "active",
          createdAt: timestamp,
          rotatedAt: timestamp,
        },
      });
      return credentialView({
        kind: "connection",
        keyId: envelope.keyId,
        status: "active",
        rotatedAt: timestamp,
      });
    },
    configureExecutionCredential: async (input) => {
      const connection = await requireOwnedUsableConnection(options.directory, input);
      validateExecutionCredential(input);
      await assertExecutionRepositoriesEnrolled(
        options.directory,
        connection.id,
        input.repositories,
      );
      const states = await options.directory.listCredentialStatesForConnection(connection.id);
      const previous = await options.directory.findActiveExecutionCredential(connection.id);
      if (previous === undefined && states.some(isRotatingExecutionCredential)) {
        throw credentialUnavailable();
      }
      const timestamp = now();
      const id = randomUUID();
      const envelope = encryptSecret(options.secrets, {
        plaintext: input.pat,
        organizationId: connection.organizationId,
        credentialId: id,
        kind: "execution",
      });
      const next: ForgejoStoredExecutionCredentialRecord = {
        id,
        organizationId: connection.organizationId,
        connectionId: connection.id,
        kind: "execution",
        status: "active",
        envelope,
        scopeEvidence: {
          scopes: [...input.scopes],
          repositories: normalizeRepositoryList(input.repositories),
        },
        createdAt: timestamp,
        rotatedAt: previous === undefined ? null : timestamp,
      };
      await options.directory.replaceActiveCredential({
        previousCredentialId: previous?.id ?? null,
        previousStatus: "revoked",
        rotatedAt: timestamp,
        next,
      });
      return credentialView({
        kind: "execution",
        keyId: envelope.keyId,
        status: "active",
        rotatedAt: timestamp,
      });
    },
    revokeExecutionCredential: async (input) => {
      const connection = await requireOwnedConnection(options.directory, input);
      const credential = await options.directory.findActiveExecutionCredential(connection.id);
      if (credential === undefined) throw credentialUnavailable();
      const timestamp = now();
      await options.directory.updateCredentialState({
        credentialId: credential.id,
        status: "revoked",
        revokedAt: timestamp,
      });
      return credentialView({
        kind: "execution",
        keyId: credential.envelope.keyId,
        status: "revoked",
        rotatedAt: credential.rotatedAt ?? null,
      });
    },
    revokeConnectionCredential: async (input) => {
      const connection = await requireOwnedConnection(options.directory, input);
      const credential = await options.directory.findActiveConnectionCredential(connection.id);
      if (credential === undefined) throw credentialUnavailable();
      const timestamp = now();
      await options.directory.updateCredentialState({
        credentialId: credential.id,
        status: "revoked",
        revokedAt: timestamp,
      });
      return credentialView({
        kind: "connection",
        keyId: credential.keyId,
        status: "revoked",
        rotatedAt: credential.rotatedAt ?? null,
      });
    },
    rotateWebhookSecret: async (input) =>
      rotateWebhookSecret({
        directory: options.directory,
        http: options.http,
        secrets: options.secrets,
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        webhookAdminPat: input.webhookAdminPat,
        now,
      }),
    disconnect: async (input) =>
      disconnectForgejoConnection({
        directory: options.directory,
        http: options.http,
        secrets: options.secrets,
        impactSource,
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        webhookAdminPat: input.webhookAdminPat,
        now,
      }),
  };
}

export function createDatabaseForgejoLifecycleImpactSource(
  database: Database,
): ForgejoLifecycleImpactSource {
  return {
    async describe(input) {
      const enrolled = input.repositories.filter((repository) => repository.enrolled);
      const targetGroups = await Promise.all(
        enrolled.map(async (repository) => ({
          repository,
          targets: await database.listActiveTriggerDispatchTargets({
            organizationId: input.organizationId,
            provider: "forgejo",
            connectionId: input.connectionId,
            resourceId: String(repository.repositoryId),
          }),
        })),
      );
      const triggerRoutes = targetGroups.flatMap(({ repository, targets }) =>
        targets.map((target) => ({
          projectId: target.projectId,
          repositoryId: repository.repositoryId,
          configurationRevisionId: target.configurationRevisionId,
        })),
      );
      const projects = await database.listProjectsForOrganization(input.organizationId);
      const configurationModels = await Promise.all(
        projects.map(async (project) => ({
          projectId: project.id,
          model: await database.projectConfigurationReadModel(project.id),
        })),
      );
      const configurationSources: ForgejoLifecycleConfigurationImpact[] = [];
      const activeRevisions: { projectId: string; revisionId: string }[] = [];
      for (const { projectId, model } of configurationModels) {
        if (
          model.sourceState.kind !== "forgejo" ||
          model.sourceState.forgejoConnectionId !== input.connectionId
        ) {
          continue;
        }
        configurationSources.push({
          projectId,
          repositoryId: model.sourceState.forgejoRepositoryId,
          activeRevisionId: model.activeRevision?.id ?? null,
        });
        if (model.activeRevision !== null) {
          activeRevisions.push({ projectId, revisionId: model.activeRevision.id });
        }
      }
      const work = await describeAffectedWork(database, [
        ...activeRevisions,
        ...triggerRoutes.map((route) => ({
          projectId: route.projectId,
          revisionId: route.configurationRevisionId,
        })),
      ]);
      return {
        configurationSources: configurationSources.sort(compareConfigurationImpact),
        activeRevisions: uniqueRevisions(activeRevisions),
        triggerRoutes: triggerRoutes.sort(compareRouteImpact),
        work,
      };
    },
  };
}

const emptyImpactSource: ForgejoLifecycleImpactSource = {
  async describe() {
    return {
      configurationSources: [],
      activeRevisions: [],
      triggerRoutes: [],
      work: emptyWorkImpact(),
    };
  },
};

async function previewDisconnect(input: {
  directory: ForgejoDirectory;
  impactSource: ForgejoLifecycleImpactSource;
  organizationId: string;
  connectionId: string;
}): Promise<ForgejoDisconnectImpact> {
  const connection = await requireOwnedConnection(input.directory, input);
  const [repositories, hooks] = await Promise.all([
    input.directory.listRepositoriesForConnection(connection.id),
    input.directory.listRepositoryHooksForConnection(connection.id),
  ]);
  const details = await input.impactSource.describe({
    organizationId: connection.organizationId,
    connectionId: connection.id,
    repositories,
  });
  const fullNames = new Map(
    repositories.map((repository) => [repository.repositoryId, repository.fullName]),
  );
  return {
    connectionId: connection.id,
    repositories: repositories
      .map((repository) => ({
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        enrolled: repository.enrolled,
      }))
      .sort(compareRepositoryImpact),
    hooks: hooks
      .map((hook) => ({
        repositoryId: hook.repositoryId,
        fullName: fullNames.get(hook.repositoryId) ?? null,
        managed: hook.managed,
        status: hook.status,
      }))
      .sort(compareHookImpact),
    configurationSources: details.configurationSources,
    activeRevisions: details.activeRevisions,
    triggerRoutes: details.triggerRoutes,
    hydrationSignals: repositories
      .filter((repository) => repository.enrolled)
      .map((repository) => ({
        repositoryId: repository.repositoryId,
        effect: "future_hydration_disabled" as const,
      }))
      .sort((left, right) => left.repositoryId - right.repositoryId),
    work: details.work,
    futureExecution: "blocked",
  };
}

async function rotateWebhookSecret(input: {
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
  organizationId: string;
  connectionId: string;
  webhookAdminPat: string;
  now: () => Date;
}): Promise<ForgejoWebhookSecretRotationResult> {
  const connection = await requireOwnedUsableConnection(input.directory, input);
  assertWebhookAdminPat(input.webhookAdminPat);
  const [active, hooks, repositories, secrets] = await Promise.all([
    input.directory.findActiveWebhookSecret(connection.id),
    input.directory.listRepositoryHooksForConnection(connection.id),
    input.directory.listRepositoriesForConnection(connection.id),
    input.directory.listWebhookSecretsForConnection(connection.id),
  ]);
  if (active === undefined) throw credentialUnavailable();
  assertNoActiveManualHooks(hooks);
  const instance = await input.directory.findInstanceById(connection.instanceId);
  if (instance === undefined || instance.status !== "active") {
    throw new ForgejoContractError(
      "forgejo_origin_unapproved",
      409,
      "Forgejo instance is unavailable",
    );
  }
  const existingOverlap = secrets.some(
    (secret) => secret.status === "rotating" && secret.id !== active.id,
  );
  const timestamp = input.now();
  let current = active;
  let plaintext = decryptWebhookSecret(input.secrets, active);
  if (!existingOverlap) {
    const id = randomUUID();
    plaintext = randomBytes(32).toString("hex");
    const envelope = encryptSecret(input.secrets, {
      plaintext,
      organizationId: connection.organizationId,
      credentialId: id,
      kind: "webhook_secret",
    });
    current = {
      id,
      organizationId: connection.organizationId,
      connectionId: connection.id,
      kind: "webhook_secret",
      alg: envelope.alg,
      keyId: envelope.keyId,
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
      aadVersion: envelope.aadVersion,
      status: "active",
      createdAt: timestamp,
      rotatedAt: timestamp,
    };
    await input.directory.replaceActiveCredential({
      previousCredentialId: active.id,
      previousStatus: "rotating",
      rotatedAt: timestamp,
      next: current,
    });
  }
  const byRepository = new Map(
    repositories.map((repository) => [repository.repositoryId, repository]),
  );
  const results: ForgejoHookReconciliationResult[] = [];
  let allReconciled = true;
  for (const hook of hooks) {
    const repository = byRepository.get(hook.repositoryId);
    if (!hook.managed || repository === undefined || !repository.enrolled) {
      if (hook.managed) allReconciled = false;
      continue;
    }
    try {
      const remote = await reconcileForgejoManagedHookSecret({
        http: input.http,
        origin: originFromInstance(instance),
        token: input.webhookAdminPat,
        repository,
        hook,
        secret: plaintext,
      });
      await input.directory.upsertRepositoryHook({
        ...hook,
        forgejoHookId: remote.hookId,
        status: remote.verified ? "active" : "pending_verification",
        lastVerifiedAt: remote.verified ? timestamp : null,
      });
      if (!remote.verified) allReconciled = false;
      results.push({
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        result: remote.verified ? "reconciled" : "pending",
      });
    } catch {
      allReconciled = false;
      await input.directory.upsertRepositoryHook({
        ...hook,
        status: "drifted",
        lastVerifiedAt: null,
      });
      results.push({
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        result: "pending",
      });
    }
  }
  if (allReconciled) {
    const currentSecrets = await input.directory.listWebhookSecretsForConnection(connection.id);
    for (const secret of currentSecrets) {
      if (secret.status !== "rotating") continue;
      await input.directory.updateCredentialState({
        credentialId: secret.id,
        status: "revoked",
        revokedAt: timestamp,
      });
    }
  }
  return {
    credential: credentialView({
      kind: "webhook_secret",
      keyId: current.keyId,
      status: "active",
      rotatedAt: current.rotatedAt ?? timestamp,
    }),
    cutover: allReconciled ? "complete" : "pending",
    hooks: results.sort((left, right) => left.repositoryId - right.repositoryId),
  };
}

async function disconnectForgejoConnection(input: {
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
  impactSource: ForgejoLifecycleImpactSource;
  organizationId: string;
  connectionId: string;
  webhookAdminPat: string | undefined;
  now: () => Date;
}): Promise<ForgejoDisconnectResult> {
  const connection = await requireOwnedConnection(input.directory, input);
  const impact = await previewDisconnect(input);
  if (connection.status !== "disconnected") {
    await input.directory.updateConnection({ ...connection, status: "disconnected" });
  }
  const timestamp = input.now();
  const states = await input.directory.listCredentialStatesForConnection(connection.id);
  for (const state of states) {
    if (state.status === "revoked") continue;
    await input.directory.updateCredentialState({
      credentialId: state.id,
      status: "revoked",
      revokedAt: timestamp,
    });
  }
  const [repositories, hooks, instance] = await Promise.all([
    input.directory.listRepositoriesForConnection(connection.id),
    input.directory.listRepositoryHooksForConnection(connection.id),
    input.directory.findInstanceById(connection.instanceId),
  ]);
  const cleanup = await cleanupManagedHooks({
    directory: input.directory,
    http: input.http,
    connection,
    instance,
    repositories,
    hooks,
    webhookAdminPat: input.webhookAdminPat,
  });
  return {
    disconnected: true,
    impact,
    cleanupStatus: cleanup.some((result) => result.result === "pending")
      ? "REMOTE_CLEANUP_PENDING"
      : "complete",
    cleanup,
  };
}

async function cleanupManagedHooks(input: {
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  connection: ForgejoConnectionRecord;
  instance: Awaited<ReturnType<ForgejoDirectory["findInstanceById"]>>;
  repositories: readonly ForgejoRepositoryRecord[];
  hooks: readonly ForgejoRepositoryHookRecord[];
  webhookAdminPat: string | undefined;
}): Promise<ForgejoRemoteCleanupResult[]> {
  const byRepository = new Map(
    input.repositories.map((repository) => [repository.repositoryId, repository]),
  );
  const results: ForgejoRemoteCleanupResult[] = [];
  for (const hook of input.hooks) {
    const repository = byRepository.get(hook.repositoryId);
    if (!hook.managed) {
      results.push({
        repositoryId: hook.repositoryId,
        fullName: repository?.fullName ?? null,
        managed: false,
        result: "preserved_manual",
      });
      continue;
    }
    if (hook.status === "unconfigured" && hook.forgejoHookId === null) {
      results.push({
        repositoryId: hook.repositoryId,
        fullName: repository?.fullName ?? null,
        managed: true,
        result: "removed",
      });
      continue;
    }
    if (
      input.instance === undefined ||
      input.instance.status !== "active" ||
      input.webhookAdminPat === undefined ||
      !isWebhookAdminPat(input.webhookAdminPat) ||
      repository === undefined ||
      hook.forgejoHookId === null
    ) {
      await input.directory.upsertRepositoryHook({ ...hook, status: "cleanup_failed" });
      results.push({
        repositoryId: hook.repositoryId,
        fullName: repository?.fullName ?? null,
        managed: true,
        result: "pending",
      });
      continue;
    }
    try {
      await removeForgejoManagedHook({
        http: input.http,
        origin: originFromInstance(input.instance),
        token: input.webhookAdminPat,
        repository,
        hook,
      });
      await input.directory.upsertRepositoryHook({
        ...hook,
        forgejoHookId: null,
        status: "unconfigured",
        lastVerifiedAt: null,
      });
      results.push({
        repositoryId: hook.repositoryId,
        fullName: repository.fullName,
        managed: true,
        result: "removed",
      });
    } catch {
      await input.directory.upsertRepositoryHook({ ...hook, status: "cleanup_failed" });
      results.push({
        repositoryId: hook.repositoryId,
        fullName: repository.fullName,
        managed: true,
        result: "pending",
      });
    }
  }
  return results.sort((left, right) => left.repositoryId - right.repositoryId);
}

async function requireOwnedConnection(
  directory: ForgejoDirectory,
  input: { organizationId: string; connectionId: string },
): Promise<ForgejoConnectionRecord> {
  const connection = await directory.findConnectionById(input.connectionId);
  if (connection === undefined || connection.organizationId !== input.organizationId) {
    throw new ForgejoContractError("not_found", 404, "Forgejo connection was not found");
  }
  return connection;
}

async function requireOwnedUsableConnection(
  directory: ForgejoDirectory,
  input: { organizationId: string; connectionId: string },
): Promise<ForgejoConnectionRecord> {
  const connection = await requireOwnedConnection(directory, input);
  if (connection.status === "disconnected") throw credentialUnavailable();
  return connection;
}

async function assertExecutionRepositoriesEnrolled(
  directory: ForgejoDirectory,
  connectionId: string,
  repositories: readonly string[],
): Promise<void> {
  const enrolled = new Set(
    (await directory.listRepositoriesForConnection(connectionId))
      .filter((repository) => repository.enrolled)
      .map((repository) => normalizeForgejoRepositoryName(repository.fullName)),
  );
  for (const repository of normalizeRepositoryList(repositories)) {
    if (!enrolled.has(repository)) {
      throw new ForgejoContractError(
        "forgejo_scope_invalid",
        400,
        "execution repositories must be enrolled on this Forgejo connection",
      );
    }
  }
}

function validateExecutionCredential(input: {
  pat: string;
  scopes: readonly string[];
  repositories: readonly string[];
}): void {
  if (input.pat.trim().length === 0 || /\s/u.test(input.pat)) {
    throw new ForgejoContractError(
      "forgejo_scope_invalid",
      400,
      "Forgejo execution PAT is invalid",
    );
  }
  if (input.scopes.length === 0 || input.repositories.length === 0) {
    throw new ForgejoContractError(
      "forgejo_scope_invalid",
      400,
      "execution credential scopes and repositories are required",
    );
  }
  for (const scope of input.scopes) {
    if (!(FORGEJO_PAT_SCOPES as readonly string[]).includes(scope)) {
      throw new ForgejoContractError(
        "forgejo_scope_invalid",
        400,
        "Forgejo execution scope is invalid",
      );
    }
  }
  if (
    !forgejoScopeCovers(input.scopes, "read:repository") ||
    !forgejoScopeCovers(input.scopes, "read:issue")
  ) {
    throw new ForgejoContractError(
      "forgejo_scope_invalid",
      400,
      "Forgejo execution scope is insufficient",
    );
  }
  for (const repository of input.repositories) {
    if (!REPOSITORY_FULL_NAME.test(repository)) {
      throw new ForgejoContractError(
        "forgejo_scope_invalid",
        400,
        "Forgejo execution repository is invalid",
      );
    }
  }
}

function assertNoActiveManualHooks(hooks: readonly ForgejoRepositoryHookRecord[]): void {
  for (const hook of hooks) {
    if (!hook.managed && hook.status !== "unconfigured") {
      throw new ForgejoContractError(
        "forgejo_scope_invalid",
        409,
        "manual Forgejo hooks must be replaced before webhook secret rotation",
      );
    }
  }
}

function normalizeRepositoryList(repositories: readonly string[]): string[] {
  return [...new Set(repositories.map(normalizeForgejoRepositoryName))].sort();
}

function assertWebhookAdminPat(value: string): void {
  if (!isWebhookAdminPat(value)) {
    throw new ForgejoContractError("forgejo_scope_invalid", 400, "webhook-admin PAT is invalid");
  }
}

function isWebhookAdminPat(value: string): boolean {
  return value.trim().length > 0 && !/\s/u.test(value);
}

function decryptWebhookSecret(
  secrets: SecretEncryptionKeySource,
  credential: ForgejoWebhookSecretRecord,
): string {
  return decryptSecret(
    secrets,
    {
      alg: "aes-256-gcm",
      keyId: credential.keyId,
      nonce: credential.nonce,
      ciphertext: credential.ciphertext,
      aadVersion: 1,
    },
    {
      organizationId: credential.organizationId,
      credentialId: credential.id,
      kind: "webhook_secret",
    },
  );
}

function credentialUnavailable(): ForgejoContractError {
  return new ForgejoContractError(
    "forgejo_credential_unavailable",
    409,
    "Forgejo credential is unavailable",
  );
}

function credentialView(input: {
  kind: ForgejoCredentialKind;
  keyId: number;
  status: ForgejoCredentialState["status"];
  rotatedAt: Date | null;
}): ForgejoCredentialLifecycleView {
  return {
    kind: input.kind,
    keyId: input.keyId,
    status: input.status,
    rotatedAt: input.rotatedAt?.toISOString() ?? null,
  };
}

function isRotatingExecutionCredential(state: ForgejoCredentialState): boolean {
  return state.kind === "execution" && state.status === "rotating";
}

function compareRepositoryImpact(
  left: ForgejoLifecycleRepositoryImpact,
  right: ForgejoLifecycleRepositoryImpact,
): number {
  return left.fullName.localeCompare(right.fullName) || left.repositoryId - right.repositoryId;
}

function compareHookImpact(
  left: ForgejoLifecycleHookImpact,
  right: ForgejoLifecycleHookImpact,
): number {
  return left.repositoryId - right.repositoryId;
}

function compareConfigurationImpact(
  left: ForgejoLifecycleConfigurationImpact,
  right: ForgejoLifecycleConfigurationImpact,
): number {
  return left.projectId.localeCompare(right.projectId) || left.repositoryId - right.repositoryId;
}

function compareRouteImpact(
  left: ForgejoLifecycleRouteImpact,
  right: ForgejoLifecycleRouteImpact,
): number {
  return (
    left.projectId.localeCompare(right.projectId) ||
    left.repositoryId - right.repositoryId ||
    left.configurationRevisionId.localeCompare(right.configurationRevisionId)
  );
}

function uniqueRevisions(
  revisions: readonly { projectId: string; revisionId: string }[],
): { projectId: string; revisionId: string }[] {
  const rows = new Map<string, { projectId: string; revisionId: string }>();
  for (const revision of revisions)
    rows.set(`${revision.projectId}:${revision.revisionId}`, revision);
  return [...rows.values()].sort(
    (left, right) =>
      left.projectId.localeCompare(right.projectId) ||
      left.revisionId.localeCompare(right.revisionId),
  );
}

function emptyWorkImpact(): ForgejoDisconnectImpact["work"] {
  return {
    queued: [],
    inFlight: [],
    queuedEffect: "revalidates_before_execution",
    inFlightEffect: "already_minted_authority_is_not_recalled",
  };
}

async function describeAffectedWork(
  database: Database,
  revisions: readonly { projectId: string; revisionId: string }[],
): Promise<ForgejoDisconnectImpact["work"]> {
  const groups = uniqueRevisions(revisions);
  const queued: ForgejoLifecycleWorkImpact[] = [];
  const inFlight: ForgejoLifecycleWorkImpact[] = [];
  for (const group of groups) {
    const runs = await database.listTriggerRunsForProject(group.projectId, WORKFLOW_SCAN_LIMIT);
    for (const run of runs) {
      if (
        run.outcome !== "accepted" ||
        run.status !== "running" ||
        run.configurationRevisionId !== group.revisionId
      ) {
        continue;
      }
      const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
      for (const step of steps) {
        const work = {
          projectId: group.projectId,
          configurationRevisionId: group.revisionId,
          triggerRunId: run.id,
          stepRunId: step.id,
        };
        if (step.status === "pending") queued.push(work);
        if (step.status === "running") inFlight.push(work);
      }
    }
  }
  const compare = (left: ForgejoLifecycleWorkImpact, right: ForgejoLifecycleWorkImpact) =>
    left.projectId.localeCompare(right.projectId) ||
    left.triggerRunId.localeCompare(right.triggerRunId) ||
    left.stepRunId.localeCompare(right.stepRunId);
  return {
    queued: queued.sort(compare),
    inFlight: inFlight.sort(compare),
    queuedEffect: "revalidates_before_execution",
    inFlightEffect: "already_minted_authority_is_not_recalled",
  };
}
