import {
  defaultBrowserIntegrationRegistry,
  INTEGRATION_EVENT_PATTERN,
  INTEGRATION_ID_PATTERN,
  RESERVED_LEGACY_INTEGRATION_IDS,
  type BrowserIntegrationRegistry,
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

/**
 * Ensures the server and browser integration registries declare the exact same integration IDs,
 * trigger events, and shared Zod schema objects so editor and server validation cannot drift.
 */
export function assertIntegrationRegistriesAligned(
  serverRegistry: IntegrationRegistry,
  browserRegistry: BrowserIntegrationRegistry,
): void {
  const serverIds = serverRegistry.ids();
  const browserIds = new Set(browserRegistry.ids());
  for (const id of serverIds) {
    if (!browserIds.has(id)) {
      throw new Error(`Server integration "${id}" is missing from the browser registry.`);
    }
  }
  const serverIdSet = new Set(serverIds);
  for (const id of browserRegistry.ids()) {
    if (!serverIdSet.has(id)) {
      throw new Error(`Browser integration "${id}" is missing from the server registry.`);
    }
  }
  for (const serverDef of serverRegistry.all()) {
    const browserDef = browserRegistry.get(serverDef.id)!;
    assertTriggerSchemasAligned(serverDef, browserDef);
    assertToolSchemasAligned(serverDef, browserDef);
  }
}

function assertTriggerSchemasAligned(
  serverDef: IntegrationDefinition,
  browserDef: NonNullable<ReturnType<BrowserIntegrationRegistry["get"]>>,
): void {
  if ((serverDef.triggers === undefined) !== (browserDef.triggers === undefined)) {
    throw new Error(
      `Integration "${serverDef.id}" must declare triggers in both server and browser registries.`,
    );
  }
  if (serverDef.triggers === undefined || browserDef.triggers === undefined) return;
  const serverEvents = serverDef.triggers.events.map((event) => event.id);
  const browserEvents = browserDef.triggers.events.map((event) => event.id);
  if (
    serverEvents.length !== browserEvents.length ||
    serverEvents.some((eventId, index) => eventId !== browserEvents[index])
  ) {
    throw new Error(
      `Integration "${serverDef.id}" trigger events differ between server and browser registries.`,
    );
  }
  if (serverDef.triggers.filterSchema !== browserDef.triggers.filterSchema) {
    throw new Error(
      `Integration "${serverDef.id}" must share the same filterSchema between server and browser registries.`,
    );
  }
}

function assertToolSchemasAligned(
  serverDef: IntegrationDefinition,
  browserDef: NonNullable<ReturnType<BrowserIntegrationRegistry["get"]>>,
): void {
  if ((serverDef.tools === undefined) !== (browserDef.tools === undefined)) {
    throw new Error(
      `Integration "${serverDef.id}" must declare tools in both server and browser registries.`,
    );
  }
  if (serverDef.tools === undefined || browserDef.tools === undefined) return;
  if (serverDef.tools.grantSchema !== browserDef.tools.grantSchema) {
    throw new Error(
      `Integration "${serverDef.id}" must share the same grantSchema between server and browser registries.`,
    );
  }
}

export const defaultIntegrationRegistry: IntegrationRegistry =
  createIntegrationRegistry(REGISTERED_INTEGRATIONS);

assertIntegrationRegistriesAligned(defaultIntegrationRegistry, defaultBrowserIntegrationRegistry);
