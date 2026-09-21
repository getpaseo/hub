import type { DaemonAgentConfigurationValidator } from "../configuration/store.js";

/** What a daemon knows about one provider: its selectable models and the modes it offers. */
export interface AgentCatalogEntry {
  models?: readonly string[];
  modes: readonly string[];
}

/**
 * A daemon that answers agent validation from a fixed catalog, the way the registry relays the
 * daemon's own answer (`hub.execution.agent.validate.request`): a model or mode the provider does
 * not offer is an issue addressed to that field, and an unknown provider is an issue on the
 * provider. Nothing is stubbed; this is the same interface the store receives in production.
 */
export function catalogAgentValidator(
  catalog: Readonly<Record<string, AgentCatalogEntry>>,
): DaemonAgentConfigurationValidator {
  return {
    validateAgentConfiguration(_daemonId, agent) {
      const entry = catalog[agent.provider];
      if (entry === undefined) {
        return Promise.resolve({
          valid: false,
          issues: [{ path: ["provider"], message: `Provider '${agent.provider}' is unavailable` }],
        });
      }
      const issues: { path: readonly (string | number)[]; message: string }[] = [];
      if (agent.model !== undefined && entry.models?.includes(agent.model) === false) {
        issues.push({
          path: ["model"],
          message: `Model '${agent.model}' is not available for provider '${agent.provider}'`,
        });
      }
      if (agent.mode !== undefined && !entry.modes.includes(agent.mode)) {
        issues.push({
          path: ["modeId"],
          message: `Mode '${agent.mode}' is not available for provider '${agent.provider}'`,
        });
      }
      return Promise.resolve(issues.length === 0 ? { valid: true } : { valid: false, issues });
    },
  };
}

/** A daemon that accepts every agent: for tests about anything other than agent validation. */
export function acceptingAgentValidator(): DaemonAgentConfigurationValidator {
  return { validateAgentConfiguration: () => Promise.resolve({ valid: true }) };
}

/** A daemon that is not connected, so no agent can be checked against it. */
export function disconnectedAgentValidator(): DaemonAgentConfigurationValidator {
  return {
    validateAgentConfiguration: () => Promise.reject(new Error("daemon_not_connected")),
  };
}
