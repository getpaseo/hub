import type { TriggerFilter } from "../../config/index.js";

/**
 * Filter matching shared by GitHub and Forgejo: from_users, connectionId,
 * pattern/contains, labels. `repo`/`resourceId`, the single `label` filter, and
 * `assignees` differ per forge and are handled in each provider's own match.ts.
 */
export interface ForgeFilterableClassification {
  readonly actor: string;
  readonly text: string;
  readonly labels: readonly string[];
}

export function matchesCommonForgeFilter(
  classified: ForgeFilterableClassification,
  filter: TriggerFilter | undefined,
  connectionId?: string | null,
): boolean {
  if (filter === undefined) return false;

  // A trigger that names nobody fires for nobody, so an author cannot accidentally
  // expose an agent to every account on the instance.
  if (filter.from_users === undefined || filter.from_users.length === 0) return false;

  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) return false;

  const pattern = readForgeStringFilter(filter, "pattern");
  if (pattern !== undefined && !classified.text.startsWith(pattern)) return false;

  const contains = readForgeStringFilter(filter, "contains");
  if (contains !== undefined && !classified.text.includes(contains)) return false;

  // Forge logins are case-insensitive on both GitHub and Forgejo, so from_users compares
  // case-insensitively too, like the label and assignee filters below.
  if (
    !filter.from_users.includes("*") &&
    !filter.from_users.some((login) => sameForgeName(login, classified.actor))
  ) {
    return false;
  }

  return matchesForgeLabelsFilter(classified.labels, filter.labels);
}

/** The `labels` filter: every named label must be among the item's current labels. */
export function matchesForgeLabelsFilter(
  currentLabels: readonly string[],
  labels: readonly string[] | undefined,
): boolean {
  return (
    labels === undefined ||
    labels.every((labelName) => currentLabels.some((current) => sameForgeName(labelName, current)))
  );
}

export function readForgeStringFilter(
  filter: TriggerFilter | undefined,
  key: "pattern" | "contains" | "label",
): string | undefined {
  const value = filter?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function sameForgeName(expected: string, actual: string | undefined): boolean {
  // Not localeCompare: with no explicit locale it falls back to the host's default,
  // and case folding is locale-dependent (Turkish "I"/"ı" is the classic case), so the
  // same login could compare equal on one host and not another.
  return actual !== undefined && expected.toLowerCase() === actual.toLowerCase();
}

/** The mention/marker a trigger's `pattern` or `contains` names, read off an already-classified message. */
export function readForgeMentionFromMessage(
  message: string,
  filter: TriggerFilter | undefined,
): string | undefined {
  const candidate = filter?.pattern ?? filter?.contains;
  return candidate !== undefined && message.includes(candidate) ? candidate : undefined;
}

/** The message a parser should see: from the first `contains` match onward, or the
 * whole message when there is none to anchor on. */
export function readForgeParserMessage(message: string, filter: TriggerFilter | undefined): string {
  const contains = readForgeStringFilter(filter, "contains");
  if (contains === undefined) return message;
  const index = message.indexOf(contains);
  return index === -1 ? message : message.slice(index);
}
