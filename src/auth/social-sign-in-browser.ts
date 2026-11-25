import { z } from "zod";
import type { SocialProvider } from "./social-sign-in.js";

const startedSignIn = z.object({ url: z.string().url() });
const FAILURE_PARAMETERS = ["error", "error_description"] as const;

/**
 * Sends the browser to the provider. The provider returns it to this exact page, invitation or
 * CLI code included, and to the same page with `?error=` when the sign-in fails.
 */
export async function beginSocialSignIn(provider: SocialProvider): Promise<void> {
  const returnPath = currentReturnPath();
  const response = await fetch("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider,
      callbackURL: returnPath,
      errorCallbackURL: returnPath,
      disableRedirect: true,
    }),
  });
  if (!response.ok) throw new Error(`social sign-in failed with status ${response.status}`);
  window.location.assign(startedSignIn.parse(await response.json()).url);
}

/**
 * Calls `returned` when the browser restores this page from its back-forward cache, which is what
 * Back from the provider's page does. The restored page still holds the state it left with.
 */
export function onBackFromProvider(returned: () => void): () => void {
  const restore = (event: PageTransitionEvent) => {
    if (event.persisted) returned();
  };
  window.addEventListener("pageshow", restore);
  return () => window.removeEventListener("pageshow", restore);
}

/** Why the provider sign-in that returned to this page failed, when one did. */
export function socialSignInFailure(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const error = new URLSearchParams(window.location.search).get("error");
  if (error === null) return undefined;
  if (error === "registration_closed") return "No account on this Hub uses that email";
  if (error === "account_not_linked") {
    return "An account with that email already exists. Sign in with your password";
  }
  if (error === "email_not_found") return "That account has no verified email Hub can read";
  if (error === "access_denied") return "Sign-in was canceled";
  return "Hub couldn't finish signing you in. Try again";
}

function currentReturnPath(): string {
  const url = new URL(window.location.href);
  for (const parameter of FAILURE_PARAMETERS) url.searchParams.delete(parameter);
  return `${url.pathname}${url.search}`;
}
