import { discordBrowserProvider } from "./discord/browser.js";
import { githubBrowserProvider } from "./github/browser.js";
import { linearBrowserProvider } from "./linear/browser.js";
import type { BrowserProviderModule } from "./presentation.js";
import { slackBrowserProvider } from "./slack/browser.js";
export const browserProviders: readonly BrowserProviderModule[] = [
  githubBrowserProvider,
  slackBrowserProvider,
  discordBrowserProvider,
  linearBrowserProvider,
];
export function browserProvider(id: string): BrowserProviderModule {
  const module = browserProviders.find((candidate) => candidate.id === id);
  if (module === undefined) throw new Error(`unknown provider: ${id}`);
  return module;
}
