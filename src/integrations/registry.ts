import {
  INTEGRATION_EVENT_PATTERN,
  INTEGRATION_ID_PATTERN,
  RESERVED_LEGACY_INTEGRATION_IDS,
} from "./browser-registry.js";
import type { IntegrationDefinition, IntegrationTriggerEventSpec } from "./contracts.js";
import { REGISTERED_INTEGRATIONS } from "./server.js";

export interface IntegrationRegistry {
  get(id: string): IntegrationDefinition | undefined;
  has(id: string): boolean;
  all(): readonly IntegrationDefinition[];
  ids(): readonly string[];
  forEvent(
    eventId: string,
  ):
    | { readonly integration: IntegrationDefinition; readonly event: IntegrationTriggerEventSpec }
    | undefined;
  withTriggers(): readonly IntegrationDefinition[];
  withTools(): readonly IntegrationDefinition[];
  withAuth(): readonly IntegrationDefinition[];
}

export function createIntegrationRegistry(
  definitions: readonly IntegrationDefinition[],
): IntegrationRegistry {
  const byId = new Map<string, IntegrationDefinition>();
  const byEvent = new Map<
    string,
    { readonly integration: IntegrationDefinition; readonly event: IntegrationTriggerEventSpec }
  >();
  const toolNames = new Set<string>();

  for (const definition of definitions) {
    validateIntegration(definition, byId, byEvent, toolNames);
    byId.set(definition.id, definition);
    for (const event of definition.triggers?.events ?? []) {
      byEvent.set(event.id, { integration: definition, event });
    }
    for (const tool of definition.tools?.tools ?? []) {
      toolNames.add(tool.definition.name);
    }
  }

  const ordered = [...byId.values()];
  const orderedIds = ordered.map((definition) => definition.id);
  const triggerDefinitions = ordered.filter((definition) => definition.triggers !== undefined);
  const toolDefinitions = ordered.filter((definition) => definition.tools !== undefined);
  const authDefinitions = ordered.filter((definition) => definition.auth !== undefined);

  return {
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    all: () => ordered,
    ids: () => orderedIds,
    forEvent: (eventId) => byEvent.get(eventId),
    withTriggers: () => triggerDefinitions,
    withTools: () => toolDefinitions,
    withAuth: () => authDefinitions,
  };
}

function validateIntegration(
  definition: IntegrationDefinition,
  byId: ReadonlyMap<string, IntegrationDefinition>,
  byEvent: ReadonlyMap<string, unknown>,
  toolNames: ReadonlySet<string>,
): void {
  if (!INTEGRATION_ID_PATTERN.test(definition.id)) {
    throw new Error(`Invalid integration ID "${definition.id}".`);
  }
  if (RESERVED_LEGACY_INTEGRATION_IDS.has(definition.id)) {
    throw new Error(`Integration ID "${definition.id}" is reserved for a built-in provider.`);
  }
  if (byId.has(definition.id)) {
    throw new Error(`Duplicate integration ID "${definition.id}".`);
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
  for (const tool of definition.tools?.tools ?? []) {
    if (tool.definition.name.length === 0) {
      throw new Error(`Integration "${definition.id}" declares a tool with an empty name.`);
    }
    if (toolNames.has(tool.definition.name)) {
      throw new Error(`Duplicate integration tool name "${tool.definition.name}".`);
    }
  }
}

export const defaultIntegrationRegistry: IntegrationRegistry =
  createIntegrationRegistry(REGISTERED_INTEGRATIONS);
