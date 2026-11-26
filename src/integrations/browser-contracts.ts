import type { ComponentType } from "react";
import type { z } from "zod";

/**
 * Browser-safe contract types for registered Hub integrations.
 *
 * This module must remain strictly free of Node, database, or server-only imports so
 * client bundles and browser components can import it without pulling server code.
 */

export interface IntegrationToolGrantBase {
  readonly connection: string;
  readonly actions: readonly string[];
}

export type IntegrationQualifierKey = string;

export interface IntegrationQualifierDefinition {
  readonly key: IntegrationQualifierKey;
  readonly kind: "string";
  readonly label: string;
  readonly description: string;
  readonly required: boolean;
}

export type IntegrationTriggerAudience = "members" | "contributors" | "everyone" | "specific";

export interface IntegrationTriggerEventSpec {
  readonly id: `${string}.${string}`;
  readonly label: string;
  readonly qualifiers?: readonly IntegrationQualifierDefinition[];
  readonly audiences?: readonly IntegrationTriggerAudience[];
  readonly replyType?: string;
  readonly audienceHint?: string;
}

export type IntegrationSetupStatus =
  | "notConfigured"
  | "verified"
  | "connected"
  | "actionNeeded"
  | "managedByEnvironment";

export type IntegrationStepSegment =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "term"; readonly value: string }
  | { readonly kind: "link"; readonly value: string; readonly href: string };

export interface IntegrationGuideStep {
  readonly segments: readonly IntegrationStepSegment[];
  readonly urls?: readonly string[];
  readonly manifest?: boolean;
  readonly permissions?: readonly { readonly name: string; readonly access: string }[];
  readonly events?: readonly string[];
}

export interface IntegrationGuideUrl {
  readonly key: string;
  readonly label: string;
  readonly path: string;
}

export interface IntegrationGuideField {
  readonly name: string;
  readonly label: string;
  readonly kind: "text" | "secret" | "multiline";
  readonly description?: string;
  readonly identifier?: string;
  readonly required: string;
  readonly optional?: true;
}

export interface IntegrationGuideGroupSource {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly unavailableAt?: (origin: string) => string | undefined;
  readonly steps: readonly IntegrationGuideStep[];
  readonly fields: readonly IntegrationGuideField[];
}

export interface IntegrationSetupGuide {
  readonly provider: string;
  readonly name: string;
  readonly summary: string;
  readonly portal: { readonly label: string; readonly href: string };
  readonly groups: readonly IntegrationGuideGroupSource[];
  readonly urls: readonly IntegrationGuideUrl[];
  readonly formTitle: string;
  readonly summaryLabels: {
    readonly identity: string;
    readonly owner?: string;
    readonly connections: string;
  };
  readonly environmentVariables: readonly string[];
  readonly savingContinues: boolean;
  readonly actions: {
    readonly save: string;
    readonly savePending: string;
    readonly connect?: string;
    readonly connectAgain?: string;
  };
  readonly saveHint?: string;
  readonly verifiedMessage?: string;
  readonly requiresHttps: boolean;
  readonly httpsRequirement: (origin: string) => string;
  readonly receivesEvents: boolean;
}

export interface IntegrationSetupVariant {
  readonly id: string;
  readonly label: string;
  readonly guide: IntegrationSetupGuide;
  /** Builds the provider application payload submitted to `verifyAndSave`. */
  buildConfiguration(
    values: Readonly<Record<string, string>>,
    expectedVersion?: number,
  ): Readonly<Record<string, unknown>>;
}

export interface IntegrationSetupExtensionProps {
  readonly callbackOrigin: string;
  readonly identifiers: Readonly<Record<string, string>>;
  readonly status: IntegrationSetupStatus;
  readonly onAction: (action: string, payload?: unknown) => Promise<unknown>;
  readonly onSaved: () => void;
}

export interface IntegrationToolFormDraft {
  readonly enabled: boolean;
  readonly connection: string;
  readonly actions: readonly string[];
  readonly fields: Readonly<Record<string, string>>;
}

export interface BrowserIntegrationToolField {
  readonly key: string;
  readonly label: string;
  readonly placeholder: string;
  readonly description?: string;
  readonly multiline?: boolean;
}

export interface BrowserIntegrationTriggersDefinition<
  TTriggerFilters extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly events: readonly IntegrationTriggerEventSpec[];
  readonly filterSchema: z.ZodType<TTriggerFilters> & { readonly shape: z.ZodRawShape };
  validateEventFilters?(event: string, filters: TTriggerFilters, ctx: z.RefinementCtx): void;
}

export interface BrowserIntegrationToolsDefinition<
  TToolGrant extends IntegrationToolGrantBase = IntegrationToolGrantBase,
> {
  readonly grantSchema: z.ZodType<TToolGrant>;
  normalizeGrant(grant: TToolGrant): TToolGrant;
  readonly actions: readonly { readonly id: string; readonly label: string }[];
  readonly fields: readonly BrowserIntegrationToolField[];
  fromGrant(grant: unknown): IntegrationToolFormDraft;
  toGrant(draft: IntegrationToolFormDraft): Readonly<Record<string, unknown>> | undefined;
  validateDraft(draft: IntegrationToolFormDraft): readonly string[];
}

export interface BrowserIntegrationSetupDefinition {
  readonly variants: readonly IntegrationSetupVariant[];
  readonly defaultVariantId: string;
  selectVariant?(identifiers: Readonly<Record<string, string>>): string;
  supportsOrgConnect?(identifiers: Readonly<Record<string, string>>): boolean;
  readonly SetupExtension?: ComponentType<IntegrationSetupExtensionProps>;
}

export interface TypedBrowserIntegrationDefinition<
  TTriggerFilters extends Record<string, unknown> = Record<string, unknown>,
  TToolGrant extends IntegrationToolGrantBase = IntegrationToolGrantBase,
> {
  readonly id: string;
  readonly label: string;
  readonly resourceNoun: string;
  readonly host?: string;
  readonly glyph: ComponentType<{ readonly className?: string }>;
  readonly setup: BrowserIntegrationSetupDefinition;
  readonly triggers?: BrowserIntegrationTriggersDefinition<TTriggerFilters>;
  readonly tools?: BrowserIntegrationToolsDefinition<TToolGrant>;
}

export interface BrowserIntegrationDefinition {
  readonly id: string;
  readonly label: string;
  readonly resourceNoun: string;
  readonly host?: string;
  readonly glyph: ComponentType<{ readonly className?: string }>;
  readonly setup: BrowserIntegrationSetupDefinition;
  readonly triggers?: BrowserIntegrationTriggersDefinition;
  readonly tools?: BrowserIntegrationToolsDefinition;
}

/**
 * Converts a strongly typed browser integration definition into a boundary-validated
 * `BrowserIntegrationDefinition` without unsafe casts or `any`.
 */
export function defineBrowserIntegration<
  TTriggerFilters extends Record<string, unknown> = Record<string, unknown>,
  TToolGrant extends IntegrationToolGrantBase = IntegrationToolGrantBase,
>(
  definition: TypedBrowserIntegrationDefinition<TTriggerFilters, TToolGrant>,
): BrowserIntegrationDefinition {
  const { triggers, tools } = definition;

  const wrappedTriggers: BrowserIntegrationTriggersDefinition | undefined =
    triggers === undefined
      ? undefined
      : {
          events: triggers.events,
          filterSchema: triggers.filterSchema,
          ...(triggers.validateEventFilters === undefined
            ? {}
            : {
                validateEventFilters: (event, filters, ctx) => {
                  const parsed = triggers.filterSchema.safeParse(filters);
                  if (!parsed.success) return;
                  triggers.validateEventFilters!(event, parsed.data, ctx);
                },
              }),
        };

  const wrappedTools: BrowserIntegrationToolsDefinition | undefined =
    tools === undefined
      ? undefined
      : {
          grantSchema: tools.grantSchema,
          normalizeGrant: (grant) => tools.normalizeGrant(tools.grantSchema.parse(grant)),
          actions: tools.actions,
          fields: tools.fields,
          fromGrant: (grant) => tools.fromGrant(grant),
          toGrant: (draft) => tools.toGrant(draft),
          validateDraft: (draft) => tools.validateDraft(draft),
        };

  return {
    id: definition.id,
    label: definition.label,
    resourceNoun: definition.resourceNoun,
    ...(definition.host === undefined ? {} : { host: definition.host }),
    glyph: definition.glyph,
    setup: definition.setup,
    ...(wrappedTriggers === undefined ? {} : { triggers: wrappedTriggers }),
    ...(wrappedTools === undefined ? {} : { tools: wrappedTools }),
  };
}
