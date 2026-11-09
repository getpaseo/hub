import { browserProvider, browserProviders } from "../providers/browser.js";
import { failed } from "../providers/connection-presentation.js";
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

export type ConnectionProvider = string;
export type ConnectionResult = string;
export const connectionResultSchema = z
  .string()
  .refine((result) => resultCopy(result) !== undefined);

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
  const provider = url.searchParams.get(RETURN_PARAMS.provider);
  const result = url.searchParams.get(RETURN_PARAMS.result);
  if (
    provider === null ||
    result === null ||
    !browserProviders.some((module) => module.id === provider)
  )
    return undefined;
  const reference = url.searchParams.get(RETURN_PARAMS.reference);
  return {
    provider,
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

export function connectionProviderName(provider: ConnectionProvider): string {
  return browserProvider(provider).guide.name;
}
/**
 * Every outcome says what happened, whether anything changed, and what to do next. A
 * cancellation is neutral because nothing about it is broken.
 */
export function connectionReturnCopy(value: ConnectionReturn): ConnectionReturnCopy {
  const render = resultCopy(value.result) ?? RETURN_COPY.connection_unavailable;
  const copy = render(connectionProviderName(value.provider));
  if (value.reference === undefined) return copy;
  return { ...copy, message: withReference(copy.message, value.reference) };
}

/**
 * A return that connected nothing is a failed request, and it is headed the way every other
 * failure on the dashboard is: the thing that did not happen, then why, then what to do next.
 */
const RETURN_COPY = {
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
} satisfies Readonly<Record<string, (name: string) => ConnectionReturnCopy>>;

const resultCopies = new Map([
  ...Object.entries(RETURN_COPY),
  ...browserProviders.flatMap((module) => Object.entries(module.connection.returns)),
]);

function resultCopy(result: string): ((name: string) => ConnectionReturnCopy) | undefined {
  return resultCopies.get(result);
}
