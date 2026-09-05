import { z } from "zod";
import { withReference } from "../failures/reference.js";

/**
 * What a provider sends the browser back with after an install or authorization, and where.
 *
 * This is the whole contract between the callback handlers and the connection surfaces: the
 * handlers only emit values from this module, and only the connection surfaces read them. A
 * result therefore cannot be displayed by a page that never started a connection, and a code
 * nobody mapped cannot leak through as raw text.
 */

export const CONNECTION_PROVIDERS = ["github", "discord", "slack", "linear"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

export const connectionResultSchema = z.enum([
  "github_connected",
  "discord_connected",
  "slack_connected",
  "linear_connected",
  "github_disconnected",
  "discord_disconnected",
  "slack_disconnected",
  "linear_disconnected",
  "github_cancelled",
  "discord_cancelled",
  "slack_cancelled",
  "linear_cancelled",
  "github_approval_required",
  "slack_bot_failed",
  "provider_not_configured",
  /** The state was forged, expired, already used, or belongs to a different session. */
  "connection_invalid",
  /** The provider account is already bound to another organization. */
  "connection_conflict",
  /** The browser that came back from the provider carried no Hub session. */
  "connection_unauthenticated",
  /** Hub itself failed; the reference correlates the banner with the operator log. */
  "connection_unavailable",
]);
export type ConnectionResult = z.infer<typeof connectionResultSchema>;

export interface ConnectionReturn {
  provider: ConnectionProvider;
  result: ConnectionResult;
  /** Failure report ID, present only when the result is Hub's own fault. */
  reference?: string;
}

export type ConnectionReturnCopy =
  | { tone: "success"; message: string }
  | { tone: "error"; title: string; message: string };

/**
 * Where a callback lands when the attempt that started it cannot be read, so neither the
 * organization nor the surface is known. The connections landing forwards to the active
 * organization's connections page; when no organization is active yet, the shell's own gates
 * render first and the return survives in the query until a connections surface reads it.
 * Never the dashboard landing: that is not a connections surface.
 */
export const CONNECTIONS_RETURN_ROUTE = "/connections";

const RETURN_PARAMS = { provider: "app", result: "result", reference: "reference" } as const;

/** The query the connections landing route accepts and forwards untouched. */
export const connectionReturnSearchSchema = z.object({
  [RETURN_PARAMS.provider]: z.string().optional(),
  [RETURN_PARAMS.result]: z.string().optional(),
  [RETURN_PARAMS.reference]: z.string().optional(),
});

export function connectionReturnUrl(
  publicBaseUrl: string,
  returnRoute: string,
  value: ConnectionReturn,
): URL {
  const url = new URL(returnRoute, publicBaseUrl);
  url.searchParams.set(RETURN_PARAMS.provider, value.provider);
  url.searchParams.set(RETURN_PARAMS.result, value.result);
  if (value.reference !== undefined) url.searchParams.set(RETURN_PARAMS.reference, value.reference);
  return url;
}

/**
 * Reads a return out of a location. Absent or malformed providers mean there is nothing to show.
 * A result code this build does not know is still a failed connection, so it is shown as one
 * instead of being echoed or dropped.
 */
export function readConnectionReturn(url: URL): ConnectionReturn | undefined {
  const provider = z
    .enum(CONNECTION_PROVIDERS)
    .safeParse(url.searchParams.get(RETURN_PARAMS.provider));
  const result = url.searchParams.get(RETURN_PARAMS.result);
  if (!provider.success || result === null) return undefined;
  const reference = url.searchParams.get(RETURN_PARAMS.reference);
  return {
    provider: provider.data,
    result: connectionResultSchema.catch("connection_unavailable").parse(result),
    ...(reference === null ? {} : { reference }),
  };
}

/** Removes a return from a location. Returns whether there was one to remove. */
export function stripConnectionReturn(url: URL): boolean {
  const present = Object.values(RETURN_PARAMS).some((name) => url.searchParams.has(name));
  for (const name of Object.values(RETURN_PARAMS)) url.searchParams.delete(name);
  return present;
}

const PROVIDER_NAMES: Readonly<Record<ConnectionProvider, string>> = {
  github: "GitHub",
  discord: "Discord",
  slack: "Slack",
  linear: "Linear",
};

export function connectionProviderName(provider: ConnectionProvider): string {
  return PROVIDER_NAMES[provider];
}

/**
 * Every outcome says what happened, whether anything changed, and what to do next. A
 * cancellation is neutral because nothing about it is broken.
 */
export function connectionReturnCopy(value: ConnectionReturn): ConnectionReturnCopy {
  const copy = RETURN_COPY[value.result](connectionProviderName(value.provider));
  if (value.reference === undefined) return copy;
  return { ...copy, message: withReference(copy.message, value.reference) };
}

/**
 * A return that connected nothing is a failed request, and it is headed the way every other
 * failure on the dashboard is: the thing that did not happen, then why, then what to do next.
 */
function failed(name: string, message: string): ConnectionReturnCopy {
  return { tone: "error", title: `${name} wasn't connected`, message };
}

const RETURN_COPY: Readonly<Record<ConnectionResult, (name: string) => ConnectionReturnCopy>> = {
  github_connected: connected,
  discord_connected: connected,
  slack_connected: connected,
  linear_connected: connected,
  github_disconnected: disconnected,
  discord_disconnected: disconnected,
  slack_disconnected: disconnected,
  linear_disconnected: disconnected,
  github_cancelled: (name) => cancelled("Installation", name),
  slack_cancelled: (name) => cancelled("Installation", name),
  discord_cancelled: (name) => cancelled("Authorization", name),
  linear_cancelled: (name) => cancelled("Authorization", name),
  github_approval_required: (name) =>
    failed(
      name,
      "A GitHub organization owner has to approve this installation. Nothing was connected. Ask an owner to approve the request, then install again.",
    ),
  slack_bot_failed: (name) =>
    failed(
      name,
      "Slack installed the app without every permission Hub needs. Nothing was saved. Reapply the manifest under Features → OAuth & Permissions, then install again.",
    ),
  provider_not_configured: (name) =>
    failed(name, "There are no saved credentials to connect yet. Verify and save the app first."),
  connection_invalid: (name) =>
    failed(
      name,
      "That connection link had already been used or had expired, so it was refused. Nothing was connected. Start the connection again from this page.",
    ),
  connection_conflict: (name) =>
    failed(
      name,
      "That account is already connected to another organization. Nothing was connected. Disconnect it there, or pick a different one.",
    ),
  connection_unauthenticated: (name) =>
    failed(
      name,
      `${name} sent you back to a Hub address this browser isn't signed in to, so nothing was connected. Sign in there, or ask your Hub operator to check the ${name} app's callback and setup URLs, then start the connection again.`,
    ),
  connection_unavailable: (name) =>
    failed(
      name,
      `Hub couldn't finish the ${name} connection. Nothing was connected. Start the connection again from this page.`,
    ),
};

function connected(name: string): ConnectionReturnCopy {
  return { tone: "success", message: `${name} connected.` };
}

function disconnected(name: string): ConnectionReturnCopy {
  return { tone: "success", message: `${name} disconnected.` };
}

function cancelled(action: "Installation" | "Authorization", name: string): ConnectionReturnCopy {
  return {
    tone: "success",
    message: `${action} cancelled at ${name}. Nothing changed. Start again when you're ready.`,
  };
}
