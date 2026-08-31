import { z } from "zod";
import type { ForgejoConfigurationProvider } from "../../configuration/forgejo-sync.js";
import type { PromptPartialReadResult } from "../../config/prompt-partials.js";
import {
  decryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import {
  ForgejoContractError,
  forgejoRequest,
  originFromInstance,
  type ForgejoDirectory,
  type ForgejoHttp,
} from "./instances.js";

const repositorySchema = z
  .object({
    id: z.number().int().positive(),
    full_name: z.string().min(1),
    default_branch: z.string().min(1),
  })
  .passthrough();
const referenceObjectSchema = z.object({ sha: z.string().min(1) }).passthrough();
const referenceSchema = z.object({ object: referenceObjectSchema }).passthrough();
const referenceListSchema = z.array(referenceSchema);
const contentSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("file"), encoding: z.literal("base64"), content: z.string() })
    .passthrough(),
  z.object({ type: z.literal("dir") }).passthrough(),
  z.object({ type: z.literal("symlink") }).passthrough(),
  z.object({ type: z.literal("submodule") }).passthrough(),
]);
const treeSchema = z
  .object({
    truncated: z.boolean(),
    tree: z.array(
      z
        .object({
          path: z.string(),
          mode: z.string(),
          type: z.enum(["blob", "tree", "commit"]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function createForgejoConfigurationProvider(options: {
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
}): ForgejoConfigurationProvider {
  async function repository(connectionId: string, repositoryId: number) {
    const connection = await options.directory.findConnectionById(connectionId);
    if (connection === undefined) {
      throw new ForgejoContractError("not_found", 404, "Forgejo connection is unavailable");
    }
    const instance = await options.directory.findInstanceById(connection.instanceId);
    if (instance === undefined) {
      throw new ForgejoContractError("not_found", 404, "Forgejo instance is unavailable");
    }
    const enrolled = (await options.directory.listRepositoriesForConnection(connectionId)).find(
      (candidate) => candidate.repositoryId === repositoryId && candidate.enrolled,
    );
    if (enrolled === undefined) {
      throw new ForgejoContractError("not_found", 404, "Forgejo repository is not enrolled");
    }
    const token = await connectionPat(options, connectionId);
    return {
      origin: originFromInstance(instance),
      owner: enrolled.ownerLogin,
      name: enrolled.name,
      repository: enrolled,
      token,
    };
  }

  return {
    async listConnectionRepositories({ connectionId }) {
      const listed = (await options.directory.listRepositoriesForConnection(connectionId)).filter(
        (candidate) => candidate.enrolled,
      );
      const repositories: Array<{
        repositoryId: number;
        fullName: string;
        defaultBranch: string;
      }> = [];
      for (const enrolled of listed) {
        try {
          const resolved = await repository(connectionId, enrolled.repositoryId);
          const response = await forgejoRequest(
            options.http,
            resolved.origin,
            `/api/v1/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.name)}`,
            resolved.token,
          );
          if (!response.ok) {
            repositories.push({
              repositoryId: enrolled.repositoryId,
              fullName: enrolled.fullName,
              defaultBranch: enrolled.defaultBranch,
            });
            continue;
          }
          const parsed = repositorySchema.parse(await response.json());
          repositories.push({
            repositoryId: parsed.id,
            fullName: parsed.full_name,
            defaultBranch: parsed.default_branch,
          });
        } catch {
          repositories.push({
            repositoryId: enrolled.repositoryId,
            fullName: enrolled.fullName,
            defaultBranch: enrolled.defaultBranch,
          });
        }
      }
      return repositories;
    },
    async readDefaultBranchHead({ connectionId, repositoryId, defaultBranch }) {
      const resolved = await repository(connectionId, repositoryId);
      const response = await forgejoRequest(
        options.http,
        resolved.origin,
        `/api/v1/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.name)}/git/refs/heads/${encodeURIComponent(defaultBranch)}`,
        resolved.token,
      );
      if (!response.ok) {
        throw new Error(`Forgejo default-branch head request failed (${String(response.status)})`);
      }
      return parseReferenceSha(await response.json());
    },
    async listFilesAtCommit({ connectionId, repositoryId, commitSha, prefix }) {
      const resolved = await repository(connectionId, repositoryId);
      const response = await forgejoRequest(
        options.http,
        resolved.origin,
        `/api/v1/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.name)}/git/trees/${encodeURIComponent(commitSha)}?recursive=true`,
        resolved.token,
      );
      if (!response.ok) {
        throw new Error(`Forgejo configuration tree request failed (${String(response.status)})`);
      }
      const tree = treeSchema.parse(await response.json());
      if (tree.truncated) throw new Error("Forgejo configuration tree response was truncated");
      return tree.tree
        .filter(({ path }) => path === prefix || path.startsWith(`${prefix}/`))
        .filter(({ type }) => type !== "tree")
        .map(({ path, type, mode }) => ({ path, kind: gitTreeEntryKind(type, mode) }));
    },
    async readFileAtCommit({ connectionId, repositoryId, commitSha, path }) {
      const resolved = await repository(connectionId, repositoryId);
      const encoded = path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const response = await forgejoRequest(
        options.http,
        resolved.origin,
        `/api/v1/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.name)}/contents/${encoded}?ref=${encodeURIComponent(commitSha)}`,
        resolved.token,
      );
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`Forgejo contents request failed (${String(response.status)})`);
      }
      return toFileAtCommit(contentSchema.parse(await response.json()));
    },
  };
}

function parseReferenceSha(body: unknown): string {
  const listed = referenceListSchema.safeParse(body);
  if (listed.success) {
    const sha = listed.data[0]?.object.sha;
    if (sha === undefined) throw new Error("Forgejo default-branch ref was empty");
    return sha;
  }
  return referenceSchema.parse(body).object.sha;
}

function gitTreeEntryKind(
  type: "blob" | "tree" | "commit",
  mode: string,
): "file" | "symlink" | "submodule" {
  if (type === "commit") return "submodule";
  if (mode === "120000") return "symlink";
  return "file";
}

function toFileAtCommit(content: z.infer<typeof contentSchema>): PromptPartialReadResult {
  if (content.type === "file") {
    return {
      kind: "file",
      content: Buffer.from(content.content.replaceAll("\n", ""), "base64").toString("utf8"),
    };
  }
  if (content.type === "dir") return { kind: "directory" };
  if (content.type === "symlink") return { kind: "symlink" };
  return { kind: "submodule" };
}

async function connectionPat(
  input: { directory: ForgejoDirectory; secrets: SecretEncryptionKeySource },
  connectionId: string,
): Promise<string> {
  const credential = await input.directory.findActiveConnectionCredential(connectionId);
  if (credential === undefined) {
    throw new ForgejoContractError(
      "forgejo_credential_unavailable",
      409,
      "Forgejo connection credential is unavailable",
    );
  }
  return decryptSecret(
    input.secrets,
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
      kind: "connection",
    },
  );
}
