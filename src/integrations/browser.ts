import type { BrowserIntegrationDefinition } from "./browser-contracts.js";

/**
 * Browser-side integration registrations.
 *
 * New integrations add their browser definition here (and their server definition in
 * `src/integrations/server.ts`). Legacy GitHub, Slack, Discord, and Linear remain on their
 * existing static paths until migrated individually.
 */
export const BROWSER_INTEGRATIONS: readonly BrowserIntegrationDefinition[] = [];
