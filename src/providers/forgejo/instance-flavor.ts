// tells forgejo, gitea and gogs apart from a GET /version response. forgejo stamps its
// version with the gitea release it forked from, e.g. "11.0.1+gitea-1.22.0"; gitea
// reports a plain semver with no such suffix. gogs has no /api/v1/version endpoint at
// all, so a 404 there reads the same as an unrecognized string: refused, not guessed at.

import type { ForgejoInstanceFlavor } from "../../db/schema.js";

export type { ForgejoInstanceFlavor };

export interface ForgejoInstanceIdentity {
  flavor: ForgejoInstanceFlavor;
  version: string;
}

const GITEA_SUFFIX = "+gitea-";
const PLAIN_SEMVER = /^\d+\.\d+\.\d+/u;

export function classifyForgejoInstanceVersion(
  version: string,
): ForgejoInstanceIdentity | undefined {
  const trimmed = version.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes(GITEA_SUFFIX)) return { flavor: "forgejo", version: trimmed };
  if (PLAIN_SEMVER.test(trimmed)) return { flavor: "gitea", version: trimmed };
  return undefined;
}

const LEADING_INTEGER = /^(\d+)/u;

// leading integer off a stored instanceVersion, "16.0.5+gitea-1.22.0" -> 16
export function forgejoMajorVersion(version: string): number | undefined {
  const match = LEADING_INTEGER.exec(version.trim());
  return match === null ? undefined : Number(match[1]);
}

const ACTION_RUN_HOOK_MIN_FORGEJO_MAJOR_VERSION = 12;

// only forgejo at major version 12+ gets asked for action_run_failure/action_run_success,
// gitea's webhook event list was never verified against these so it's refused rather
// than guessed at. not required for correctness on an older forgejo either, addHook
// silently ignores an event string it doesn't recognize; this just keeps an old
// instance's hook ui from seeing an event it's never heard of.
export function supportsForgejoActionRunHookEvents(connection: {
  instanceFlavor: ForgejoInstanceFlavor;
  instanceVersion: string;
}): boolean {
  if (connection.instanceFlavor !== "forgejo") return false;
  const major = forgejoMajorVersion(connection.instanceVersion);
  return major !== undefined && major >= ACTION_RUN_HOOK_MIN_FORGEJO_MAJOR_VERSION;
}
