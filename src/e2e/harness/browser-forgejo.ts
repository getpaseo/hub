/**
 * Browser-harness Forgejo journeys. T01 composes the inert registration once.
 * T02 fills instance approval, connection, and repository enrollment journeys.
 */
export const BROWSER_FORGEJO_SCENARIOS = ["forgejo-not-configured", "forgejo-configured"] as const;

export type BrowserForgejoScenario = (typeof BROWSER_FORGEJO_SCENARIOS)[number];
