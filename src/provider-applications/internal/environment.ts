import type { ProviderRegistry } from "../../providers/registry.js";
import type { Provider, ProviderApplicationConfiguration } from "../index.js";
/** @package */
export async function readProviderApplicationEnvironment(
  environment: Record<string, string | undefined>,
  registry: ProviderRegistry,
): Promise<Partial<Record<Provider, ProviderApplicationConfiguration>>> {
  const entries: [string, ProviderApplicationConfiguration][] = [];
  for (const module of registry.list()) {
    const configuration = await module.application.readEnvironment(environment);
    if (configuration !== undefined) entries.push([module.manifest.id, configuration]);
  }
  return Object.fromEntries(entries);
}
