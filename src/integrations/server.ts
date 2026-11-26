import type { IntegrationDefinition } from "./contracts.js";

/**
 * Server-side integration registrations.
 *
 * New integrations add their server definition here (and their browser definition in
 * `src/integrations/browser.ts`). Legacy GitHub, Slack, Discord, and Linear remain on their
 * existing static paths until migrated individually.
 */
export const REGISTERED_INTEGRATIONS: readonly IntegrationDefinition[] = [];
