import { respondError } from "../contract/respond.js";
import { browserProvider } from "../providers/browser.js";
import { respondWithFailure } from "../failures/index.js";
import { guideFor } from "./guides.js";
import { ProviderApplicationError, type Provider } from "./index.js";

/**
 * Every way saving an app can fail, said the same way twice over: what happened, then the exact
 * next thing to do. Two rules hold across the whole table. Nothing is ever persisted by a failed
 * save, so every message may say so and none of them may leave the operator wondering. And a
 * message names the portal page and field to fix whenever the provider told us which one it was.
 */
export function providerApplicationSaveFailure(
  provider: Provider,
  error: unknown,
  scrubValues: readonly string[] = [],
  operation = "provider_application.verify_and_save",
): ReturnType<typeof respondError> {
  const module = browserProvider(provider);
  const name = module.guide.name;
  const failure = module.failure;
  const code = errorCode(error);
  const diagnostic = failure.diagnostic?.(error);
  const report = { operation, component: "provider_applications", provider } as const;

  if (module.guide.requiresHttps && code === "httpsRequired") {
    return respondWithFailure(
      error,
      report,
      {
        fallback: `${name} only works over HTTPS, and Hub is at ${errorContext(error) ?? "an HTTP address"}. Nothing was saved. Reopen Hub at its public HTTPS address to set up ${name}.`,
      },
      { kind: "validation", scrubValues },
    );
  }
  if (code === "managedByEnvironment") {
    return respondWithFailure(
      error,
      report,
      {
        fallback: `${name} is set by Hub's environment, so it cannot be edited here. Nothing was saved. Change ${environmentVariables(provider)} where you set Hub's environment, then restart Hub.`,
      },
      { kind: "conflict", scrubValues },
    );
  }
  if (code === "configurationConflict") {
    return respondWithFailure(
      error,
      report,
      {
        fallback: `Someone else changed the ${name} app while this page was open. Nothing was saved. Reload the page to see the current values, then verify again.`,
      },
      { kind: "conflict", scrubValues },
    );
  }
  if (code === "identityConflict") {
    const identity = errorContext(error) ?? name;
    return respondWithFailure(
      error,
      report,
      {
        fallback: `${name} is already connected as ${identity}, and connections cannot move to a different ${failure.applicationNoun}. Nothing was saved. Remove its connections first, or rotate the secrets of the same ${failure.applicationNoun}.`,
      },
      { kind: "conflict", scrubValues },
    );
  }
  if (code === "credentialsRejected") {
    return respondWithFailure(
      error,
      report,
      { fallback: failure.credentials(errorContext(error)) },
      { kind: "credentialsRejected", scrubValues },
    );
  }
  const special = failure.special?.(code, errorContext(error));
  if (special !== undefined)
    return respondWithFailure(
      error,
      report,
      { fallback: special.message },
      { kind: special.kind, scrubValues, ...(diagnostic === undefined ? {} : { diagnostic }) },
    );

  return respondWithFailure(
    error,
    report,
    {
      fallback: `Something went wrong while saving ${name}. Nothing was saved. Try again.`,
      forbidden: `Only an instance operator can change the ${name} app. Nothing was saved.`,
      authentication: `Your session has expired. Nothing was saved. Sign in again, then verify again.`,
      credentialsRejected: failure.credentials(errorContext(error)),
      permissionMissing: `${name} accepted the credentials but the ${failure.applicationNoun} is missing a permission Hub needs. Nothing was saved. Grant every permission listed in the setup steps, then verify again.`,
      network: `Hub couldn't reach ${name}. Nothing was saved. Check this server's network, DNS, and TLS access to ${providerHost(provider)}, then verify again.`,
      timeout: `${name} didn't answer in time. Nothing was saved. Check this server's connection to ${providerHost(provider)}, then verify again.`,
      rateLimited: `${name} is rate limiting Hub. Nothing was saved. Wait a few minutes, then verify again.`,
      upstreamUnavailable: `${name} returned an error of its own. Nothing was saved. Check ${name}'s status page, then verify again.`,
      conflict: `The ${name} app changed while it was being saved. Nothing was saved. Reload the page to see the current values, then verify again.`,
      validation: `Some of the ${name} details were missing or malformed. Nothing was saved. Check every field against the setup steps, then verify again.`,
    },
    { scrubValues, ...(diagnostic === undefined ? {} : { diagnostic }) },
  );
}

export function providerHost(provider: Provider): string {
  return browserProvider(provider).failure.host;
}
export function providerName(provider: Provider): string {
  return browserProvider(provider).guide.name;
}

function environmentVariables(provider: Provider): string {
  const names = guideFor(provider).environmentVariables;
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof ProviderApplicationError) return error.code;
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function errorContext(error: unknown): string | undefined {
  if (error instanceof ProviderApplicationError) return error.safeContext;
  if (typeof error !== "object" || error === null) return undefined;
  const context: unknown = Reflect.get(error, "safeContext");
  return typeof context === "string" ? context : undefined;
}
