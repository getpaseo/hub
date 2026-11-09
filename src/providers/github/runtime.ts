import {
  createExecutionAuthority,
  type CreateExecutionAuthorityOptions,
} from "../../execution-authority/index.js";
import { ProviderRuntimeDefinition, type ActiveProviderRuntime } from "../active-runtime.js";
import type { ProviderRegistration } from "../registration.js";
export interface GitHubAuthorityRegistration {
  mint(input: {
    projectId: string;
    connectionSlug: string;
    repositories: readonly string[];
    permissions: Readonly<Record<string, "read" | "write" | "admin">>;
  }): Promise<{
    token: string;
    expiresAt: number;
    botUserId: number;
    botLogin: string;
  }>;
  revoke(token: string): Promise<void>;
}
export interface GitHubRegistration extends ProviderRegistration {
  githubAuthority?: GitHubAuthorityRegistration;
}
export const githubRuntime = new ProviderRuntimeDefinition<GitHubRegistration>(
  "github",
  isGitHubRegistration,
);
function unavailable(): Error {
  const error = new Error("github authority unavailable");
  error.name = "ProviderRuntimeUnavailableError";
  return Object.assign(error, { code: "github_authority_unavailable" });
}
export function githubAuthority(runtime: ActiveProviderRuntime): GitHubAuthorityRegistration {
  return {
    mint: (input) =>
      runtime.use(githubRuntime, (registration) => {
        const authority = registration?.githubAuthority;
        if (authority === undefined) throw unavailable();
        return authority.mint(input);
      }),
    revoke: (token) =>
      runtime.use(githubRuntime, (registration) => {
        const authority = registration?.githubAuthority;
        if (authority === undefined) throw unavailable();
        return authority.revoke(token);
      }),
  };
}
export function githubExecutionAuthority(
  options: Omit<CreateExecutionAuthorityOptions, "githubAuthority">,
  runtime: ActiveProviderRuntime,
) {
  return createExecutionAuthority({ ...options, githubAuthority: githubAuthority(runtime) });
}
export function staticGitHubExecutionAuthority(
  options: Omit<CreateExecutionAuthorityOptions, "githubAuthority">,
  registrations: readonly ProviderRegistration[],
) {
  const native = registrations
    .map((registration) => githubRuntime.find(registration))
    .find((registration) => registration?.githubAuthority !== undefined);
  return createExecutionAuthority({
    ...options,
    ...(native?.githubAuthority === undefined ? {} : { githubAuthority: native.githubAuthority }),
  });
}

function isGitHubRegistration(
  registration: ProviderRegistration,
): registration is GitHubRegistration {
  if (!("githubAuthority" in registration) || registration.githubAuthority === undefined)
    return true;
  const authority = registration.githubAuthority;
  return (
    typeof authority === "object" &&
    authority !== null &&
    "mint" in authority &&
    typeof authority.mint === "function" &&
    "revoke" in authority &&
    typeof authority.revoke === "function"
  );
}
