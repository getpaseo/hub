import { discordProvider } from "./discord/module.js";
import { githubProvider } from "./github/module.js";
import { linearProvider } from "./linear/module.js";
import { ProviderRegistry } from "./registry.js";
import { slackProvider } from "./slack/module.js";
export function createProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([githubProvider, slackProvider, discordProvider, linearProvider]);
}
