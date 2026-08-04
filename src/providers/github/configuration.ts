import { z } from "zod";
import type { GitHubAuth } from "../../auth/github.js";
import type { GitHubConfigurationProvider } from "../../configuration/github-sync.js";

const repositorySchema = z
  .object({
    id: z.number().int().positive(),
    full_name: z.string().min(1),
    default_branch: z.string().min(1),
  })
  .passthrough();
const repositoryListSchema = z.object({ repositories: z.array(repositorySchema) }).passthrough();
const referenceSchema = z.object({ object: z.object({ sha: z.string().min(1) }) }).passthrough();
const contentSchema = z
  .object({ type: z.literal("file"), encoding: z.literal("base64"), content: z.string() })
  .passthrough();

export function createGitHubConfigurationProvider(auth: GitHubAuth): GitHubConfigurationProvider {
  async function repository(installationId: number, repositoryId: number) {
    const octokit = await auth.createInstallationOctokit(installationId);
    const response = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: repositoryId,
    });
    const parsed = repositorySchema.parse(response.data);
    const [owner, name] = splitFullName(parsed.full_name);
    return { octokit, owner, name, repository: parsed };
  }

  return {
    async listInstallationRepositories({ installationId }) {
      const octokit = await auth.createInstallationOctokit(installationId);
      const repositories: Array<{ repositoryId: number; fullName: string; defaultBranch: string }> =
        [];
      for (let page = 1; ; page += 1) {
        const response = await octokit.request("GET /installation/repositories", {
          per_page: 100,
          page,
        });
        const listed = repositoryListSchema.parse(response.data).repositories;
        repositories.push(
          ...listed.map((item) => ({
            repositoryId: item.id,
            fullName: item.full_name,
            defaultBranch: item.default_branch,
          })),
        );
        if (listed.length < 100) return repositories;
      }
    },
    async readDefaultBranchHead({ installationId, repositoryId, defaultBranch }) {
      const resolved = await repository(installationId, repositoryId);
      const response = await resolved.octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner: resolved.owner,
        repo: resolved.name,
        ref: `heads/${defaultBranch}`,
      });
      return referenceSchema.parse(response.data).object.sha;
    },
    async readFileAtCommit({ installationId, repositoryId, commitSha, path }) {
      const resolved = await repository(installationId, repositoryId);
      try {
        const response = await resolved.octokit.request(
          "GET /repos/{owner}/{repo}/contents/{path}",
          {
            owner: resolved.owner,
            repo: resolved.name,
            path,
            ref: commitSha,
          },
        );
        const content = contentSchema.parse(response.data);
        return {
          rawYaml: Buffer.from(content.content.replaceAll("\n", ""), "base64").toString("utf8"),
        };
      } catch (error) {
        if (hasStatus(error, 404)) return undefined;
        throw error;
      }
    },
  };
}

function splitFullName(fullName: string): [string, string] {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts[0]?.length === 0 || parts[1]?.length === 0) {
    throw new Error("GitHub returned an invalid repository identity");
  }
  return [parts[0]!, parts[1]!];
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "status") === status;
}
