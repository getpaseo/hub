import { z } from "zod";
const sourceSchema = z.object({
  github_connection_id: z.string(),
  github_repository_id: z.number(),
  github_repository_full_name: z.string(),
  github_default_branch: z.string(),
  automatic_deployment_enabled: z.boolean(),
});
export function parseSourceState(value: unknown) {
  const result = sourceSchema.safeParse(value);
  if (!result.success) throw new Error("github configuration authority has no repository");
  const row = result.data;
  return {
    kind: "github" as const,
    githubConnectionId: row.github_connection_id,
    githubRepositoryId: row.github_repository_id,
    githubRepositoryFullName: row.github_repository_full_name,
    githubDefaultBranch: row.github_default_branch,
    automaticDeploymentEnabled: row.automatic_deployment_enabled,
  };
}
