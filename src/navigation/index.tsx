import { trimPathRight, useMatches } from "@tanstack/react-router";

/**
 * The route the outlet is presenting, including its pending state. The browser's location
 * advances before that presentation changes; using it for page context mislabels the old page.
 */
export function usePresentedPathname(): string {
  // Index matches end in a slash even when their public URL does not.
  return useMatches({ select: (matches) => trimPathRight(matches.at(-1)!.pathname) });
}
