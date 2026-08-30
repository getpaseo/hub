import { z } from "zod";

export type ForgejoPermissionLevel = "read" | "write";

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
    for (const [index, repository] of value.repositories.entries()) {
      if (!REPOSITORY_FULL_NAME.test(repository)) {
        throw new Error(`${path}.repositories[${String(index)}] is not owner/name`);
      }
    }
  }
}

export function isForgejoAuthorityEnvironmentKey(key: string): boolean {
  return RESERVED_ENVIRONMENT_KEYS.has(key) || INDEXED_GIT_CONFIG_KEY.test(key);
}
