/**
 * The providers a Hub run can use.
 *
 * Every run Hub launches carries a tool policy that preapproves the Hub MCP tools (`hub.reply`,
 * `hub.finish_execution`), because nobody is at the keyboard to approve them. A daemon accepts
 * that policy only for providers whose contract supports exact MCP preapproval — `PROVIDER_CONTRACTS`
 * in getpaseo/paseo `packages/server/src/server/agent/provider-registry.ts` — and refuses every
 * other provider at launch with "cannot preapprove exact MCP tools for unattended execution".
 * The daemon's provider snapshot does not carry that flag, so Hub keeps the same list and refuses
 * at save instead. Delete this file once the snapshot says it per provider.
 */
const UNATTENDED_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex", "opencode"]);

export function supportsUnattendedRuns(provider: string): boolean {
  return UNATTENDED_PROVIDERS.has(provider);
}

/** The daemon's own sentence, said before the run instead of after it. */
export function unattendedProviderRefusal(provider: string): string {
  return `Provider '${provider}' cannot run unattended Hub automations; select Claude, Codex, or OpenCode.`;
}
