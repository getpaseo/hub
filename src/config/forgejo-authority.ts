import { z } from "zod";

export type ForgejoPermissionLevel = "read" | "write";

export const FORGEJO_PAT_SCOPES = [
  "read:issue",
  "write:issue",
  "read:repository",
  "write:repository",
] as const;

export type ForgejoPatScope = (typeof FORGEJO_PAT_SCOPES)[number];

export type ForgejoAuthorityErrorCode =
  | "forgejo_authority_unavailable"
  | "forgejo_connection_unavailable"
  | "forgejo_credential_unavailable"
  | "forgejo_repository_unenrolled"
  | "forgejo_scope_invalid"
  | "forgejo_authority_scope_invalid";

const CONNECTION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REPOSITORY_FULL_NAME = /^[^/\s]+\/[^/\s]+$/u;
const FORGEJO_PERMISSION = z.enum(["read", "write"]);
const RESERVED_ENVIRONMENT_KEYS = new Set([
  "FORGEJO_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
]);
const INDEXED_GIT_CONFIG_KEY = /^GIT_CONFIG_(?:KEY|VALUE)_[0-9]+$/u;
const FORGEJO_GIT_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; echo username=oauth2; echo password=$FORGEJO_TOKEN; }; f';

export interface AuthoredForgejoAuthority {
  connection: string;
  repositories?: readonly string[] | undefined;
  contents?: ForgejoPermissionLevel | undefined;
  issues?: ForgejoPermissionLevel | undefined;
}

export interface CompiledForgejoAuthority {
  connection: string;
  repositories?: readonly string[] | undefined;
  contents: ForgejoPermissionLevel;
  issues: ForgejoPermissionLevel;
}

export const AuthoredForgejoAuthoritySchema = z
  .object({
    connection: z.string().regex(CONNECTION_SLUG),
    repositories: z.array(z.string().regex(REPOSITORY_FULL_NAME)).min(1).optional(),
    contents: FORGEJO_PERMISSION.optional(),
    issues: FORGEJO_PERMISSION.optional(),
  })
  .strict();

export const CompiledForgejoAuthoritySchema: z.ZodType<CompiledForgejoAuthority> = z
  .object({
    connection: z.string().regex(CONNECTION_SLUG),
    repositories: z.array(z.string().regex(REPOSITORY_FULL_NAME)).min(1).optional(),
    contents: FORGEJO_PERMISSION,
    issues: FORGEJO_PERMISSION,
  })
  .strict();

export function compileForgejoAuthority(
  value: AuthoredForgejoAuthority,
  path: string,
): CompiledForgejoAuthority {
  validateForgejoAuthority(
    {
      connection: value.connection,
      repositories: value.repositories,
      contents: value.contents ?? "read",
      issues: value.issues ?? "read",
    },
    path,
  );
  return {
    connection: value.connection,
    ...(value.repositories === undefined ? {} : { repositories: value.repositories }),
    contents: value.contents ?? "read",
    issues: value.issues ?? "read",
  };
}

export function validateForgejoAuthority(value: CompiledForgejoAuthority, path: string): void {
  if (!CONNECTION_SLUG.test(value.connection)) {
    throw new Error(`${path}.connection is not a connection slug`);
  }
  if (value.repositories !== undefined) {
    if (value.repositories.length === 0) {
      throw new Error(`${path}.repositories must name at least one repository`);
    }
    for (const [index, repository] of value.repositories.entries()) {
      if (!REPOSITORY_FULL_NAME.test(repository)) {
        throw new Error(`${path}.repositories[${String(index)}] is not owner/name`);
      }
    }
  }
  if (value.contents !== "read" && value.contents !== "write") {
    throw new Error(`${path}.contents must be read or write`);
  }
  if (value.issues !== "read" && value.issues !== "write") {
    throw new Error(`${path}.issues must be read or write`);
  }
}

export function isForgejoAuthority(value: unknown): value is CompiledForgejoAuthority {
  return CompiledForgejoAuthoritySchema.safeParse(value).success;
}

export function isForgejoAuthorityEnvironmentKey(key: string): boolean {
  return RESERVED_ENVIRONMENT_KEYS.has(key) || INDEXED_GIT_CONFIG_KEY.test(key);
}

export class ForgejoAuthorityError extends Error {
  readonly code: ForgejoAuthorityErrorCode;

  constructor(code: ForgejoAuthorityErrorCode, message: string) {
    super(message);
    this.name = "ForgejoAuthorityError";
    this.code = code;
  }
}

export interface ForgejoExecutionScopeEvidence {
  scopes: readonly string[];
  repositories: readonly string[];
}

export function requiredForgejoPatScopes(input: {
  contents: ForgejoPermissionLevel;
  issues: ForgejoPermissionLevel;
}): readonly ForgejoPatScope[] {
  return [
    input.contents === "write" ? "write:repository" : "read:repository",
    input.issues === "write" ? "write:issue" : "read:issue",
  ];
}

export function forgejoScopeCovers(
  approved: readonly string[],
  required: ForgejoPatScope,
): boolean {
  if (required === "read:repository") {
    return approved.includes("read:repository") || approved.includes("write:repository");
  }
  if (required === "read:issue") {
    return approved.includes("read:issue") || approved.includes("write:issue");
  }
  return approved.includes(required);
}

export function assertForgejoCapabilitySubset(
  requested: { contents: ForgejoPermissionLevel; issues: ForgejoPermissionLevel },
  evidence: ForgejoExecutionScopeEvidence,
  path = "forgejo",
): void {
  const unknown = evidence.scopes.filter(
    (scope) => !(FORGEJO_PAT_SCOPES as readonly string[]).includes(scope),
  );
  if (unknown.length > 0) {
    throw new ForgejoAuthorityError(
      "forgejo_scope_invalid",
      `${path}: execution credential has unsupported Forgejo scopes`,
    );
  }
  for (const required of requiredForgejoPatScopes(requested)) {
    if (!forgejoScopeCovers(evidence.scopes, required)) {
      throw new ForgejoAuthorityError(
        "forgejo_scope_invalid",
        `${path}: requested ${required} exceeds the execution credential`,
      );
    }
  }
}

export function repositoriesForForgejoAuthority(
  forgejo: CompiledForgejoAuthority,
  triggerContext: unknown,
): readonly string[] {
  if (forgejo.repositories !== undefined) return forgejo.repositories;
  if (
    typeof triggerContext === "object" &&
    triggerContext !== null &&
    "provider" in triggerContext &&
    triggerContext.provider === "forgejo" &&
    "target" in triggerContext &&
    typeof triggerContext.target === "object" &&
    triggerContext.target !== null &&
    "repository" in triggerContext.target &&
    typeof triggerContext.target.repository === "string"
  ) {
    return [triggerContext.target.repository];
  }
  throw new ForgejoAuthorityError(
    "forgejo_authority_scope_invalid",
    "forgejo.repositories is required for this trigger source; Hub cannot safely expand authority to all connection repositories",
  );
}

export function normalizeForgejoRepositoryName(value: string): string {
  return value.trim().toLowerCase();
}

export function assertForgejoRepositoriesEnrolled(
  requested: readonly string[],
  enrolled: readonly string[],
  path = "forgejo.repositories",
): void {
  const enrolledSet = new Set(enrolled.map(normalizeForgejoRepositoryName));
  for (const repository of requested) {
    if (!enrolledSet.has(normalizeForgejoRepositoryName(repository))) {
      throw new ForgejoAuthorityError(
        "forgejo_repository_unenrolled",
        `${path}: ${repository} is not enrolled on the selected Forgejo connection`,
      );
    }
  }
}

export function assertForgejoRepositoriesInExecutionBoundary(
  requested: readonly string[],
  evidence: ForgejoExecutionScopeEvidence,
  path = "forgejo.repositories",
): void {
  const bounded = new Set(evidence.repositories.map(normalizeForgejoRepositoryName));
  for (const repository of requested) {
    if (!bounded.has(normalizeForgejoRepositoryName(repository))) {
      throw new ForgejoAuthorityError(
        "forgejo_scope_invalid",
        `${path}: ${repository} is outside the execution PAT repository boundary`,
      );
    }
  }
}

export interface ForgejoDaemonIdentity {
  origin: string;
  userId: number;
  login: string;
}

export function forgejoDaemonEnvironment(
  identity: ForgejoDaemonIdentity,
  token: string,
): Record<string, string> {
  const origin = identity.origin.replace(/\/$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ForgejoAuthorityError(
      "forgejo_connection_unavailable",
      "Forgejo instance origin is unavailable",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new ForgejoAuthorityError(
      "forgejo_connection_unavailable",
      "Forgejo instance origin must be https",
    );
  }
  const host = parsed.host;
  return {
    FORGEJO_TOKEN: token,
    GIT_CONFIG_COUNT: "5",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: identity.login,
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: `${String(identity.userId)}+${identity.login}@noreply.${parsed.hostname}`,
    GIT_CONFIG_KEY_2: `url.${origin}/.insteadOf`,
    GIT_CONFIG_VALUE_2: `git@${host}:`,
    GIT_CONFIG_KEY_3: `url.${origin}/.insteadOf`,
    GIT_CONFIG_VALUE_3: `ssh://git@${host}/`,
    GIT_CONFIG_KEY_4: `credential.${origin}.helper`,
    GIT_CONFIG_VALUE_4: FORGEJO_GIT_CREDENTIAL_HELPER,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}
