/**
 * Which authored trigger filter keys belong to which provider. assignees means
 * different things per provider (Forgejo logins added, Linear user IDs eligible to be
 * assigned, GitHub reads neither), so this table is what catches a mismatch.
 */
export const UNIVERSAL_FILTER_KEYS = ["from_users", "connection", "inputs"] as const;

export const PROVIDER_FILTER_KEYS: Readonly<Record<string, readonly string[]>> = {
  github: ["pattern", "contains", "label", "labels", "repo"],
  forgejo: ["pattern", "contains", "label", "labels", "repo", "assignees", "reviewers", "branches"],
  discord: ["pattern", "contains", "guild", "channels"],
  slack: ["pattern", "contains", "workspace", "channels"],
  linear: ["pattern", "contains", "project", "states", "exclude_labels", "assignees", "labels"],
};

/**
 * The full set of filter keys `provider` accepts, or undefined when unrestricted.
 * Only forgejo is enforced today. Extend to another provider only alongside auditing
 * its existing authored configs for keys it would newly reject.
 */
export function allowedFilterKeysForProvider(provider: string): ReadonlySet<string> | undefined {
  if (provider !== "forgejo") return undefined;
  const providerKeys = PROVIDER_FILTER_KEYS[provider];
  if (providerKeys === undefined) return undefined;
  return new Set<string>([...UNIVERSAL_FILTER_KEYS, ...providerKeys]);
}
