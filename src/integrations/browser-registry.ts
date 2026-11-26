import type {
  BrowserIntegrationDefinition,
  IntegrationTriggerEventSpec,
} from "./browser-contracts.js";
import { BROWSER_INTEGRATIONS } from "./browser.js";

export const INTEGRATION_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u;
export const INTEGRATION_EVENT_PATTERN = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/u;
export const RESERVED_LEGACY_INTEGRATION_IDS: ReadonlySet<string> = new Set([
  "github",
  "slack",
  "discord",
  "linear",
]);

export interface BrowserIntegrationRegistry {
  get(id: string): BrowserIntegrationDefinition | undefined;
  has(id: string): boolean;
  all(): readonly BrowserIntegrationDefinition[];
  ids(): readonly string[];
  forEvent(eventId: string):
    | {
        readonly integration: BrowserIntegrationDefinition;
        readonly event: IntegrationTriggerEventSpec;
      }
    | undefined;
  withTriggers(): readonly BrowserIntegrationDefinition[];
  withTools(): readonly BrowserIntegrationDefinition[];
}

export function createBrowserIntegrationRegistry(
  definitions: readonly BrowserIntegrationDefinition[],
): BrowserIntegrationRegistry {
  const byId = new Map<string, BrowserIntegrationDefinition>();
  const byEvent = new Map<
    string,
    {
      readonly integration: BrowserIntegrationDefinition;
      readonly event: IntegrationTriggerEventSpec;
    }
  >();

  for (const definition of definitions) {
    validateBrowserIntegration(definition, byId, byEvent);
    byId.set(definition.id, definition);
    for (const event of definition.triggers?.events ?? []) {
      byEvent.set(event.id, { integration: definition, event });
    }
  }

  const ordered = [...byId.values()];
  const orderedIds = ordered.map((definition) => definition.id);
  const triggerDefinitions = ordered.filter((definition) => definition.triggers !== undefined);
  const toolDefinitions = ordered.filter((definition) => definition.tools !== undefined);

  return {
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    all: () => ordered,
    ids: () => orderedIds,
    forEvent: (eventId) => byEvent.get(eventId),
    withTriggers: () => triggerDefinitions,
    withTools: () => toolDefinitions,
  };
}

function validateBrowserIntegration(
  definition: BrowserIntegrationDefinition,
  byId: ReadonlyMap<string, BrowserIntegrationDefinition>,
  byEvent: ReadonlyMap<string, unknown>,
): void {
  if (!INTEGRATION_ID_PATTERN.test(definition.id)) {
    throw new Error(`Invalid integration ID "${definition.id}".`);
  }
  if (RESERVED_LEGACY_INTEGRATION_IDS.has(definition.id)) {
    throw new Error(`Integration ID "${definition.id}" is reserved for a built-in provider.`);
  }
  if (byId.has(definition.id)) {
    throw new Error(`Duplicate browser integration ID "${definition.id}".`);
  }
  if (definition.setup.variants.length === 0) {
    throw new Error(`Integration "${definition.id}" must declare at least one setup variant.`);
  }
  if (
    !definition.setup.variants.some((variant) => variant.id === definition.setup.defaultVariantId)
  ) {
    throw new Error(
      `Integration "${definition.id}" default variant "${definition.setup.defaultVariantId}" does not exist.`,
    );
  }
  const eventPrefix = `${definition.id}.`;
  for (const event of definition.triggers?.events ?? []) {
    if (!INTEGRATION_EVENT_PATTERN.test(event.id) || !event.id.startsWith(eventPrefix)) {
      throw new Error(
        `Integration "${definition.id}" event "${event.id}" must use "${eventPrefix}<occurrence>" format.`,
      );
    }
    if (byEvent.has(event.id)) {
      throw new Error(`Duplicate integration trigger event "${event.id}".`);
    }
  }
}

export const defaultBrowserIntegrationRegistry: BrowserIntegrationRegistry =
  createBrowserIntegrationRegistry(BROWSER_INTEGRATIONS);
