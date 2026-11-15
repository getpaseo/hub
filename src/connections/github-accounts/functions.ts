import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { respondOk, type Result } from "../../contract/respond.js";
import { respondWithFailure } from "../../failures/index.js";
import { handleConnections } from "../../server/runtime.js";
import { connectionOperationRequest } from "../operation-request.server.js";

/**
 * The chooser's three requests. Each carries only the attempt's state; the daemon side reads
 * what the attempt verified and refuses anything else. When the attempt is gone, or a step
 * fails, the answer is where to send the browser, so the page never has to explain a failure
 * the connections page already knows how to show.
 */

const availabilitySchema = z.enum(["available", "connected", "connectedElsewhere", "notOwner"]);
const choiceSchema = z.object({
  installationId: z.number().int().positive(),
  accountLogin: z.string(),
  accountType: z.string(),
  availability: availabilitySchema,
});
const chooserSchema = z.object({
  returnRoute: z.string(),
  choices: z.array(choiceSchema),
});
/** The chooser's link may carry any state at all; the attempt decides whether it is real. */
const choicesSchema = z.object({ state: z.string() });
const stateSchema = z.object({ state: z.string().min(1) });
const chooseSchema = stateSchema.extend({ installationId: z.number().int().positive() });

export type GitHubAccountChoice = z.infer<typeof choiceSchema>;
export type GitHubAccountChooser = z.infer<typeof chooserSchema>;

/** Where the browser goes next. */
export interface Destination {
  url: string;
}

const UNAVAILABLE = "Hub couldn't reach this GitHub connection. Connect GitHub again.";

export const githubAccountChoices = createServerFn({ method: "GET" })
  .validator(choicesSchema)
  .handler(async ({ data }): Promise<Result<GitHubAccountChooser | Destination>> => {
    try {
      const response = await handleConnections(
        connectionOperationRequest("GET", "/connections/github/choices", data),
        "githubChoices",
      );
      const destination = redirectOf(response);
      if (destination !== undefined) return respondOk(destination);
      if (!response.ok) throw new Error(`github choices returned HTTP ${response.status}`);
      return respondOk(chooserSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, context("connection.github.choices"), {
        fallback: UNAVAILABLE,
      });
    }
  });

export const chooseGitHubAccount = createServerFn({ method: "POST" })
  .validator(chooseSchema)
  .handler(({ data }) =>
    follow("connection.github.choose", "githubChoose", {
      state: data.state,
      installationId: String(data.installationId),
    }),
  );

export const addGitHubAccount = createServerFn({ method: "POST" })
  .validator(stateSchema)
  .handler(({ data }) => follow("connection.github.add_account", "githubAddAccount", data));

async function follow(
  operation: string,
  action: "githubChoose" | "githubAddAccount",
  params: Readonly<Record<string, string>>,
): Promise<Result<Destination>> {
  try {
    const response = await handleConnections(
      connectionOperationRequest("POST", "/connections/github", params),
      action,
    );
    const destination = redirectOf(response);
    if (destination === undefined) {
      throw new Error(`github chooser returned HTTP ${response.status}`);
    }
    return respondOk(destination);
  } catch (error) {
    return respondWithFailure(error, context(operation), { fallback: UNAVAILABLE });
  }
}

function redirectOf(response: Response): Destination | undefined {
  const location = response.headers.get("location");
  return response.status >= 300 && response.status < 400 && location !== null
    ? { url: location }
    : undefined;
}

function context(operation: string) {
  return { operation, component: "connections", provider: "github" } as const;
}
