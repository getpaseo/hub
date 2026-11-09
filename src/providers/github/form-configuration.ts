import { z } from "zod";
import { setYamlField } from "../../triggers/configuration/yaml-field.js";
import type { ProviderFormField, ProviderTriggerForm } from "../configuration.js";
import { AuthoredGitHubAuthoritySchema } from "./authority-configuration.js";

const formSchema = z.object({
  githubConnection: z.string(),
  githubRepositories: z.string(),
  githubPermissions: z.string(),
  githubDuration: z.string(),
});
const permissionsSchema = z.record(z.string(), z.enum(["read", "write", "admin"]));
export const formConfiguration: ProviderTriggerForm = {
  initialValues: {
    githubConnection: "",
    githubRepositories: "",
    githubPermissions: "",
    githubDuration: "1h",
  },
  project(run) {
    const github =
      run["github"] === undefined ? undefined : AuthoredGitHubAuthoritySchema.parse(run["github"]);
    return {
      githubConnection: github?.connection ?? "",
      githubRepositories: github?.repositories?.join(", ") ?? "",
      githubPermissions:
        github?.permissions === undefined ? "" : JSON.stringify(github.permissions, null, 2),
      githubDuration: github?.duration ?? "",
    };
  },
  authored(value) {
    const github = authoredAuthority(formSchema.parse(value));
    return github === undefined ? {} : { github };
  },
  patch(document, value) {
    setYamlField(document, ["run", "github"], authoredAuthority(formSchema.parse(value)));
  },
  errors(value) {
    const fields = formSchema.parse(value);
    if (fields.githubConnection.trim().length === 0) return {};
    try {
      parsePermissions(fields.githubPermissions);
      return {};
    } catch (error) {
      return {
        githubPermissions: error instanceof Error ? error.message : "The trigger is invalid.",
      };
    }
  },
  section(value, connections) {
    const fields = formSchema.parse(value);
    const controls: ProviderFormField[] = [
      {
        key: "githubConnection",
        id: "trigger-github-connection",
        label: "GitHub connection",
        description: "Mints a short-lived, restricted GH_TOKEN for this run.",
        kind: "choice",
        value: fields.githubConnection,
        options: [
          { value: "", label: "Do not inject a GitHub token" },
          ...connections
            .filter((connection) => connection.provider === "github")
            .map((connection) => ({ value: connection.slug, label: connection.label })),
        ],
        placeholder: "Select a GitHub connection",
        empty: "No GitHub connections found.",
      },
    ];
    if (fields.githubConnection !== "")
      controls.push(
        {
          key: "githubRepositories",
          id: "trigger-github-repositories",
          label: "GitHub repositories",
          description: "Comma-separated owner/repository names.",
          kind: "text",
          value: fields.githubRepositories,
          required: true,
        },
        {
          key: "githubDuration",
          id: "trigger-github-duration",
          label: "GitHub token lifetime",
          description: "At most 1h.",
          kind: "text",
          value: fields.githubDuration,
          required: true,
        },
        {
          key: "githubPermissions",
          id: "trigger-github-permissions",
          label: "GitHub permissions (JSON)",
          description: "Defaults to read-only repository contents when empty.",
          kind: "multiline",
          value: fields.githubPermissions,
          placeholder: '{"contents":"write","pull_requests":"write"}',
        },
      );
    return {
      id: "trigger-github",
      title: "GitHub access",
      description: "Give the run a short-lived token scoped to the repositories you name.",
      initialOpen: fields.githubConnection !== "",
      fields: controls,
    };
  },
};
function authoredAuthority(value: z.infer<typeof formSchema>) {
  const connection = blankToUndefined(value.githubConnection);
  if (connection === undefined) return undefined;
  const repositories = value.githubRepositories
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const permissions = parsePermissions(value.githubPermissions);
  const duration = blankToUndefined(value.githubDuration);
  return {
    connection,
    ...(repositories.length === 0 ? {} : { repositories }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(duration === undefined ? {} : { duration }),
  };
}
function parsePermissions(value: string): Record<string, "read" | "write" | "admin"> | undefined {
  if (value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GitHub permissions must be valid JSON.");
  }
  const permissions = permissionsSchema.safeParse(parsed);
  if (!permissions.success)
    throw new Error('GitHub permissions map a scope to "read", "write", or "admin".');
  return permissions.data;
}
function blankToUndefined(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}
