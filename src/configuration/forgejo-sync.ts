import {
  compileHubBundle,
  HUB_RESOURCE_PATH,
  HubBundleError,
  type HubBundleFile,
} from "../config/bundle.js";
import { compareBundlePaths } from "../config/bundle-contract.js";
import { rawConfigurationHash } from "../config/compiler.js";
import type { PromptPartialReadResult } from "../config/prompt-partials.js";
import type { Database, ProjectConfigurationRevisionRecord } from "../db/types.js";
import { reportFailure } from "../failures/index.js";
import type { ForgejoConfigSyncConsumer } from "../triggers/forgejo/dispatch.js";
import type { NormalizedForgejoEvent } from "../triggers/forgejo/normalize.js";
import { ConfigurationActivationValidationError, ProjectConfigurationStore } from "./store.js";

export interface ForgejoConfigurationProvider {
  listConnectionRepositories(input: {
    connectionId: string;
  }): Promise<Array<{ repositoryId: number; fullName: string; defaultBranch: string }>>;
  readDefaultBranchHead(input: {
    connectionId: string;
    repositoryId: number;
    defaultBranch: string;
  }): Promise<string>;
  listFilesAtCommit(input: {
    connectionId: string;
    repositoryId: number;
    commitSha: string;
    prefix: string;
  }): Promise<readonly { path: string; kind: PromptPartialReadResult["kind"] }[]>;
  readFileAtCommit(input: {
    connectionId: string;
    repositoryId: number;
    commitSha: string;
    path: string;
  }): Promise<PromptPartialReadResult | undefined>;
}

export type ForgejoConfigurationSyncResult =
  | { outcome: "activated"; revision: ProjectConfigurationRevisionRecord }
  | { outcome: "invalid"; revision: ProjectConfigurationRevisionRecord }
  | { outcome: "fetch_failed" }
  | { outcome: "superseded" };

const projectSyncTails = new Map<string, Promise<unknown>>();

export async function synchronizeForgejoProjectConfiguration(input: {
  database: Database;
  client: Pick<ForgejoConfigurationProvider, "listFilesAtCommit" | "readFileAtCommit">;
  projectId: string;
  forgejoConnectionId: string;
  forgejoRepositoryId: number;
  forgejoRepositoryFullName: string;
  forgejoDefaultBranch: string;
  commitSha: string;
  webhookDeliveryId: string | null;
  configurationForProject?: (projectId: string) => ProjectConfigurationStore;
}): Promise<ForgejoConfigurationSyncResult> {
  return withProjectSyncLock(input.projectId, () => runForgejoProjectConfiguration(input));
}

export async function synchronizeForgejoDefaultBranch(input: {
  database: Database;
  client: ForgejoConfigurationProvider;
  projectId: string;
  repositoryId?: number;
  expectedCommitSha?: string;
  webhookDeliveryId: string | null;
  configurationForProject?: (projectId: string) => ProjectConfigurationStore;
}): Promise<ForgejoConfigurationSyncResult | undefined> {
  const target = await input.database.findForgejoConfigurationTarget(
    input.projectId,
    input.repositoryId,
  );
  if (target === undefined || !target.automaticDeploymentEnabled) return undefined;
  let branchHead: string;
  try {
    branchHead = await input.client.readDefaultBranchHead({
      connectionId: target.connectionId,
      repositoryId: target.repositoryId,
      defaultBranch: target.defaultBranch,
    });
  } catch (error) {
    reportConfigurationSyncFailure(error, "default-branch-head", input.projectId);
    await recordAttempt(
      {
        database: input.database,
        projectId: input.projectId,
        forgejoConnectionId: target.connectionId,
        forgejoRepositoryId: target.repositoryId,
        commitSha: input.expectedCommitSha ?? "unknown",
        webhookDeliveryId: input.webhookDeliveryId,
      },
      "fetch_failed",
      { stage: "default_branch_head", reason: "provider_request_failed" },
    );
    return { outcome: "fetch_failed" };
  }
  if (input.expectedCommitSha !== undefined && branchHead !== input.expectedCommitSha) {
    await recordAttempt(
      {
        database: input.database,
        projectId: input.projectId,
        forgejoConnectionId: target.connectionId,
        forgejoRepositoryId: target.repositoryId,
        commitSha: input.expectedCommitSha,
        webhookDeliveryId: input.webhookDeliveryId,
      },
      "superseded",
      { branchHead },
    );
    return { outcome: "superseded" };
  }
  return synchronizeForgejoProjectConfiguration({
    database: input.database,
    client: input.client,
    projectId: input.projectId,
    forgejoConnectionId: target.connectionId,
    forgejoRepositoryId: target.repositoryId,
    forgejoRepositoryFullName: target.fullName,
    forgejoDefaultBranch: target.defaultBranch,
    commitSha: branchHead,
    webhookDeliveryId: input.webhookDeliveryId,
    ...(input.configurationForProject === undefined
      ? {}
      : { configurationForProject: input.configurationForProject }),
  });
}

export function createForgejoConfigSyncConsumer(options: {
  database: Database;
  client: ForgejoConfigurationProvider;
  configurationForProject?: (projectId: string) => ProjectConfigurationStore;
}): ForgejoConfigSyncConsumer {
  return {
    async consume(input) {
      if (!input.event.defaultBranchPush) return;
      const connectionId = input.event.context.connectionId;
      const repositoryId = input.event.context.repository.id;
      const connection = await options.database.forgejoDirectory().findConnectionById(connectionId);
      if (connection === undefined) return;
      const expectedCommitSha = pushCommitSha(input.event);
      const targets = await options.database.listForgejoConfigurationTargets(
        connection.organizationId,
        connectionId,
        repositoryId,
      );
      await Promise.all(
        targets
          .filter((target) => target.automaticDeploymentEnabled)
          .map((target) =>
            synchronizeForgejoDefaultBranch({
              database: options.database,
              client: options.client,
              projectId: target.projectId,
              repositoryId,
              webhookDeliveryId: input.delivery.deliveryId,
              ...(expectedCommitSha === undefined ? {} : { expectedCommitSha }),
              ...(options.configurationForProject === undefined
                ? {}
                : { configurationForProject: options.configurationForProject }),
            }),
          ),
      );
    },
  };
}

async function runForgejoProjectConfiguration(
  input: Parameters<typeof synchronizeForgejoProjectConfiguration>[0],
): Promise<ForgejoConfigurationSyncResult> {
  const existing = await existingActiveForgejoRevision(
    input.database,
    input.projectId,
    input.commitSha,
  );
  if (existing !== undefined) {
    await recordAttempt(input, "activated", { revisionId: existing.id, reason: "existing_commit" });
    return { outcome: "activated", revision: existing };
  }
  const files = await readForgejoBundle(input);
  if (files === undefined) return { outcome: "fetch_failed" };
  if ("invalid" in files) {
    const revision = await recordInvalidBundle(input, files.invalid.files, files.invalid.issues);
    await recordAttempt(input, "invalid", {
      revisionId: revision.id,
      stage: files.invalid.stage,
    });
    return { outcome: "invalid", revision };
  }
  try {
    compileHubBundle(files);
  } catch (error) {
    if (!(error instanceof HubBundleError)) throw error;
    const revision = await recordInvalidBundle(input, files, error.issues);
    await recordAttempt(input, "invalid", { revisionId: revision.id, stage: "bundle" });
    return { outcome: "invalid", revision };
  }
  const store =
    input.configurationForProject?.(input.projectId) ??
    new ProjectConfigurationStore(input.database, input.projectId);
  const revision = await store.insertForgejoBundleRevision({
    files,
    forgejoConnectionId: input.forgejoConnectionId,
    forgejoRepositoryId: input.forgejoRepositoryId,
    forgejoRepositoryFullName: input.forgejoRepositoryFullName,
    forgejoDefaultBranch: input.forgejoDefaultBranch,
    commitSha: input.commitSha,
    webhookDeliveryId: input.webhookDeliveryId,
  });
  if (revision.validationErrors !== null) {
    await recordAttempt(input, "invalid", { revisionId: revision.id, stage: "validation" });
    return { outcome: "invalid", revision };
  }
  try {
    const activated = await store.activate(revision.id);
    await recordAttempt(input, "activated", { revisionId: activated.revision.id });
    return { outcome: "activated", revision: activated.revision };
  } catch (error) {
    if (!(error instanceof ConfigurationActivationValidationError)) throw error;
    await recordAttempt(input, "invalid", { revisionId: revision.id, stage: "validation" });
    return { outcome: "invalid", revision };
  }
}

async function readForgejoBundle(
  input: Parameters<typeof synchronizeForgejoProjectConfiguration>[0],
): Promise<
  | HubBundleFile[]
  | undefined
  | {
      invalid: {
        files: readonly HubBundleFile[];
        issues: readonly { path: readonly (string | number)[]; message: string }[];
        stage: string;
      };
    }
> {
  let listed: readonly { path: string; kind: PromptPartialReadResult["kind"] }[];
  try {
    listed = await input.client.listFilesAtCommit({
      connectionId: input.forgejoConnectionId,
      repositoryId: input.forgejoRepositoryId,
      commitSha: input.commitSha,
      prefix: ".paseo",
    });
  } catch (error) {
    reportConfigurationSyncFailure(error, "bundle-list", input.projectId);
    await recordAttempt(input, "fetch_failed", {
      stage: "bundle-list",
      reason: "provider_request_failed",
    });
    return undefined;
  }
  if (!listed.some(({ path }) => path === HUB_RESOURCE_PATH)) {
    await recordAttempt(input, "fetch_failed", { reason: "hub_resource_not_found_at_commit" });
    return undefined;
  }
  const invalidEntry = listed.find(({ kind }) => kind !== "file");
  if (invalidEntry !== undefined) {
    return {
      invalid: {
        files: [],
        issues: [
          {
            path: [invalidEntry.path],
            message: `configuration bundle entry is not a regular file (${invalidEntry.kind})`,
          },
        ],
        stage: "bundle-kind",
      },
    };
  }
  const files: HubBundleFile[] = [];
  try {
    for (const entry of listed.toSorted(compareBundlePaths)) {
      const read = await input.client.readFileAtCommit({
        connectionId: input.forgejoConnectionId,
        repositoryId: input.forgejoRepositoryId,
        commitSha: input.commitSha,
        path: entry.path,
      });
      if (read === undefined || read.kind !== "file") {
        throw new Error(`file changed or disappeared at exact commit: ${entry.path}`);
      }
      files.push({ path: entry.path, content: read.content });
    }
  } catch (error) {
    reportConfigurationSyncFailure(error, "bundle-read", input.projectId);
    await recordAttempt(input, "fetch_failed", {
      stage: "bundle-read",
      reason: "provider_request_failed",
    });
    return undefined;
  }
  return files;
}

async function existingActiveForgejoRevision(
  database: Database,
  projectId: string,
  commitSha: string,
): Promise<ProjectConfigurationRevisionRecord | undefined> {
  const active = await database.findActiveProjectConfiguration(projectId);
  if (active === undefined || active.sourceKind !== "forgejo" || active.validationErrors !== null) {
    return undefined;
  }
  return forgejoEvidenceCommitSha(active.sourceEvidence) === commitSha ? active : undefined;
}

async function recordInvalidBundle(
  input: Parameters<typeof synchronizeForgejoProjectConfiguration>[0],
  files: readonly HubBundleFile[],
  issues: readonly { path: readonly (string | number)[]; message: string }[],
) {
  return input.database.insertProjectConfigurationRevision({
    projectId: input.projectId,
    sourceKind: "forgejo",
    sourceEvidence: {
      kind: "forgejo",
      forgejoConnectionId: input.forgejoConnectionId,
      forgejoRepositoryId: input.forgejoRepositoryId,
      forgejoRepositoryFullName: input.forgejoRepositoryFullName,
      forgejoDefaultBranch: input.forgejoDefaultBranch,
      commitSha: input.commitSha,
      path: HUB_RESOURCE_PATH,
      webhookDeliveryId: input.webhookDeliveryId,
      bundle: { files, authoredHash: rawConfigurationHash(files) },
    },
    rawYaml: files.find(({ path }) => path === HUB_RESOURCE_PATH)?.content ?? null,
    normalizedConfiguration: null,
    validationErrors: {
      formErrors: issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    },
    contentHash: rawConfigurationHash(files),
  });
}

function recordAttempt(
  input: {
    database: Database;
    projectId: string;
    forgejoConnectionId: string;
    forgejoRepositoryId: number;
    commitSha: string;
    webhookDeliveryId: string | null;
  },
  outcome: "activated" | "invalid" | "fetch_failed" | "superseded",
  evidence: unknown,
) {
  return input.database.recordConfigurationSyncAttempt({
    projectId: input.projectId,
    forgejoConnectionId: input.forgejoConnectionId,
    forgejoRepositoryId: input.forgejoRepositoryId,
    webhookDeliveryId: input.webhookDeliveryId,
    commitSha: input.commitSha,
    outcome,
    evidence,
  });
}

function withProjectSyncLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectSyncTails.get(projectId) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  projectSyncTails.set(
    projectId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function pushCommitSha(event: NormalizedForgejoEvent): string | undefined {
  const subject = event.context.subject;
  if (subject === null || subject.kind !== "commit") return undefined;
  return typeof subject.id === "string" ? subject.id : String(subject.id);
}

function forgejoEvidenceCommitSha(evidence: unknown): string | undefined {
  if (!isRecord(evidence) || evidence["kind"] !== "forgejo") return undefined;
  const commitSha = evidence["commitSha"];
  return typeof commitSha === "string" ? commitSha : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportConfigurationSyncFailure(error: unknown, stage: string, projectId: string): void {
  reportFailure(error, {
    operation: `forgejo.configuration.${stage}`,
    component: "configuration",
    provider: "forgejo",
    projectId,
  });
}
