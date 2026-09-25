import { z } from "zod";
import { respondWithFailure } from "../failures/index.js";
import { connectionContext, connectionResponseFailure } from "./connection-failure.js";

// server-only, not re-exported from functions.ts: a top-level export survives client
// bundling and would drag respondWithFailure's node:async_hooks chain along with it.
// functions.ts only calls this from inside handler bodies, which get stripped for the
// browser. tests import straight from here.

const forgejoErrorBodySchema = z.object({ error: z.string() });

// reads the error code a forgejo endpoint's non-ok response body carries, so a specific
// refusal can show its own message instead of the generic fallback
export async function readForgejoErrorCode(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => undefined);
  return forgejoErrorBodySchema.safeParse(body).data?.error;
}

// resolve returning undefined means the status matched but the body didn't carry the
// expected code, so the caller falls through to its generic fallback
export interface ForgejoErrorCase {
  status: number;
  resolve: (response: Response) => Promise<string | undefined> | string | undefined;
}

// shared 403/non-ok/fallback handling for every forgejo server function in functions.ts
export async function forgejoOperationFailure(
  operation: string,
  response: Response,
  report: {
    organizationSlug: string;
    projectSlug?: string | undefined;
    provider: "forgejo";
  },
  options: {
    permissionMessage: string;
    fallbackMessage: string;
    cases?: readonly ForgejoErrorCase[];
  },
) {
  if (response.status === 403) {
    return connectionResponseFailure(
      "connection." + operation,
      response,
      options.permissionMessage,
      report,
    );
  }
  for (const errorCase of options.cases ?? []) {
    if (response.status !== errorCase.status) continue;
    const message = await errorCase.resolve(response);
    if (message === undefined) continue;
    return respondWithFailure(
      new Error(`forgejo ${operation} refused: ${response.status}`),
      connectionContext("connection." + operation, report),
      { fallback: message, validation: message, conflict: message },
      { status: response.status },
    );
  }
  return connectionResponseFailure(
    "connection." + operation,
    response,
    options.fallbackMessage,
    report,
  );
}
