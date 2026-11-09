import { z } from "zod";

export type QualifierKey = string;
export type QualifierValues = Partial<Record<QualifierKey, string>>;
export interface QualifierDefinition {
  key: QualifierKey;
  kind: "string";
  label: string;
  description: string;
  required: boolean;
}
export interface EventDefinition {
  provider: string;
  label: string;
  origin: "hub" | "provider";
  qualifiers: readonly QualifierDefinition[];
}
export const optionalTextFilter = z.string().optional();
export const optionalNonEmptyTextFilter = z.string().min(1).optional();
export const optionalNonEmptyListFilter = z.array(z.string().min(1)).min(1).optional();
export interface ProviderLaunchPolicyInput {
  name: string;
  on: string;
  filters?: Readonly<Record<string, unknown>> | undefined;
}
export interface ProviderConfigurationDefinition {
  filterFields: Readonly<Record<string, z.ZodType>>;
  projectLegacyFilters(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  allowsLaunchWithoutActor?(trigger: ProviderLaunchPolicyInput): boolean;
  provider: string;
  order: number;
  events: Readonly<Record<string, { label: string; qualifiers?: readonly QualifierDefinition[] }>>;
  replyType?: string;
  defaultEvent?: string;
}
export type EditorEvent = string;
export class ProviderConfigurationCatalog {
  private readonly filterFields = new Map<string, z.ZodType>();
  private readonly definitions = new Map<string, EventDefinition>();
  private readonly providers = new Map<string, ProviderConfigurationDefinition>();
  constructor(providers: readonly ProviderConfigurationDefinition[]) {
    for (const provider of [...providers].sort((a, b) => a.order - b.order)) {
      if (provider.provider === "manual" || provider.provider === "schedule")
        throw new Error(`reserved Hub source: ${provider.provider}`);
      if (this.providers.has(provider.provider))
        throw new Error(`trigger provider already registered: ${provider.provider}`);
      this.providers.set(provider.provider, provider);
      for (const [key, schema] of Object.entries(provider.filterFields)) {
        const existing = this.filterFields.get(key);
        if (existing !== undefined && existing !== schema)
          throw new Error(`conflicting filter field: ${key}`);
        this.filterFields.set(key, schema);
      }
      for (const [id, event] of Object.entries(provider.events)) {
        if (!id.startsWith(`${provider.provider}.`) || this.definitions.has(id))
          throw new Error(`invalid registered event: ${id}`);
        this.definitions.set(id, {
          provider: provider.provider,
          label: event.label,
          origin: "provider",
          qualifiers: event.qualifiers ?? [],
        });
      }
    }
    this.definitions.set("schedule.tick", {
      provider: "schedule",
      label: "Schedule",
      origin: "hub",
      qualifiers: [],
    });
    this.definitions.set("manual.run", {
      provider: "manual",
      label: "Manual run",
      origin: "hub",
      qualifiers: [],
    });
  }
  filterSchema<Shape extends z.ZodRawShape>(base: z.ZodObject<Shape>) {
    return base.catchall(z.unknown()).transform((value, context) => {
      const unknownKeys: string[] = [];
      for (const [key, field] of Object.entries(value)) {
        if (Object.hasOwn(base.shape, key)) continue;
        const schema = this.filterFields.get(key);
        if (schema === undefined) {
          unknownKeys.push(key);
          continue;
        }
        const parsed = schema.safeParse(field);
        if (parsed.success) Object.assign(value, { [key]: parsed.data });
        else
          for (const issue of parsed.error.issues)
            context.addIssue({ ...issue, path: [key, ...issue.path] });
      }
      if (unknownKeys.length > 0)
        context.addIssue({ code: "unrecognized_keys", keys: unknownKeys });
      return value;
    });
  }
  projectLegacyFilters(
    value: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    const projected: Record<string, unknown> = {};
    for (const provider of this.providers.values())
      Object.assign(projected, provider.projectLegacyFilters(value));
    return projected;
  }
  allowsLaunchWithoutActor(trigger: ProviderLaunchPolicyInput): boolean {
    return (
      this.providers.get(trigger.on.split(".")[0] ?? "")?.allowsLaunchWithoutActor?.(trigger) ===
      true
    );
  }
  list(): readonly string[] {
    return [...this.definitions.keys()];
  }
  has(value: string): boolean {
    return this.definitions.has(value);
  }
  parse(value: string): string {
    return this.has(value) ? value : "manual.run";
  }
  definition(value: string): EventDefinition {
    const definition = this.definitions.get(value);
    if (definition === undefined) throw new Error(`unknown trigger event: ${value}`);
    return definition;
  }
  replyType(event: string): string | undefined {
    return this.providers.get(event.split(".")[0] ?? "")?.replyType;
  }
  defaultFor(connections: readonly { provider: string; slug: string }[]): {
    event: string;
    connection: string;
  } {
    for (const definition of this.providers.values()) {
      if (definition.defaultEvent === undefined) continue;
      const connection = connections.find(
        (candidate) => candidate.provider === definition.provider,
      );
      if (connection !== undefined)
        return { event: definition.defaultEvent, connection: connection.slug };
    }
    return { event: "manual.run", connection: "" };
  }
}

export function qualifierValue(filters: object | undefined, key: string): string | undefined {
  const value: unknown = Reflect.get(filters ?? {}, key);
  return typeof value === "string" ? value : undefined;
}
