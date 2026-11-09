import {
  createExecutionAuthority,
  type CreateExecutionAuthorityOptions,
  type ProviderExecutionAuthority,
} from "../../execution-authority/index.js";
import {
  CompiledGitHubAuthoritySchema,
  type CompiledGitHubAuthority,
} from "./authority-configuration.js";
import type { GitHubAuthorityRegistration } from "./runtime.js";

export interface CreateGitHubExecutionAuthorityOptions extends Omit<
  CreateExecutionAuthorityOptions,
  "providerAuthorities"
> {
  githubAuthority?: GitHubAuthorityRegistration | undefined;
}
export function createGitHubExecutionAuthority(options: CreateGitHubExecutionAuthorityOptions) {
  const { githubAuthority, ...shared } = options;
  return createExecutionAuthority({
    ...shared,
    providerAuthorities: new Map([["github", githubExecutionAuthorityProvider(githubAuthority)]]),
  });
}
export function githubExecutionAuthorityProvider(
  authority: GitHubAuthorityRegistration | undefined,
): ProviderExecutionAuthority {
  return {
    step: {
      requires: (input) => input["github"] !== undefined,
      async materialize(input, register) {
        const request = CompiledGitHubAuthoritySchema.parse(input["github"]);
        if (authority === undefined)
          throw authorityError(
            "github_authority_unavailable",
            "GitHub step authority is unavailable",
          );
        const github = await authority.mint({
          projectId: input.projectId,
          connectionSlug: request.connection,
          repositories: repositoriesForAuthority(request, input.triggerContext),
          permissions: request.permissions,
        });
        await register(
          { provider: "github", token: github.token, expiresAt: github.expiresAt },
          request.durationMs,
        );
        return githubEnvironment(github.botUserId, github.botLogin, github.token);
      },
    },
    revoke(token) {
      if (authority === undefined) throw new Error("GitHub credential revocation is unavailable");
      return authority.revoke(token);
    },
  };
}
function repositoriesForAuthority(
  github: CompiledGitHubAuthority,
  triggerContext: unknown,
): readonly string[] {
  if (github.repositories !== undefined) return github.repositories;
  if (
    typeof triggerContext === "object" &&
    triggerContext !== null &&
    "provider" in triggerContext &&
    triggerContext.provider === "github" &&
    "target" in triggerContext &&
    typeof triggerContext.target === "object" &&
    triggerContext.target !== null &&
    "repository" in triggerContext.target &&
    typeof triggerContext.target.repository === "string"
  ) {
    return [triggerContext.target.repository];
  }
  throw authorityError(
    "github_authority_scope_invalid",
    "github.repositories is required for this trigger source; Hub cannot safely expand authority to all installation repositories",
  );
}

function githubEnvironment(
  botUserId: number,
  botLogin: string,
  token: string,
): Record<string, string> {
  return {
    GH_TOKEN: token,
    GIT_CONFIG_COUNT: "5",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: botLogin,
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: `${botUserId}+${botLogin}@users.noreply.github.com`,
    GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_2: "git@github.com:",
    GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
    GIT_CONFIG_KEY_4: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_4: "!gh auth git-credential",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function authorityError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
