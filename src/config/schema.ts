import { z } from "zod";

export type MergeVariableAst =
  | { kind: "literal"; value: string }
  | { kind: "event"; path: readonly string[]; raw: string }
  | { kind: "connection"; slug: string; value: string; raw: string };

export type MergeTemplateAst = readonly MergeVariableAst[];

export interface ParsedTemplate {
  value: string;
  ast: MergeTemplateAst;
}

const TriggerEventNameSchema = z.templateLiteral([z.string().min(1), ".", z.string().min(1)]);
const TIMEOUT_MULTIPLIERS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
} as const;
type TriggerTimeoutUnit = keyof typeof TIMEOUT_MULTIPLIERS;
const MAX_TRIGGER_TIMEOUT_MS = 24 * 60 * 60_000;
const TriggerTimeoutSchema = z
  .string()
  .regex(/^([1-9][0-9]*)(ms|s|m|h)$/u)
  .refine(
    (timeout) => {
      const duration = readTriggerTimeout(timeout);
      return (
        duration === undefined ||
        duration.value * timeoutMultiplier(duration.unit) <= MAX_TRIGGER_TIMEOUT_MS
      );
    },
    {
      message: "trigger timeout must not exceed 24h",
    },
  );

export const DEFAULT_TRIGGER_TIMEOUT = "1h";
export const DEFAULT_TRIGGER_IDLE_TIMEOUT = "5m";

const AgentConfigSchema = z.object({
  provider: z.string().min(1),
  mode: z.string().min(1),
  model: z.string().min(1).optional(),
  thinkingOptionId: z.string().min(1).optional(),
});

export const AllowOutputSchema = z.object({
  type: TriggerEventNameSchema,
});

const BaseEnvironmentSchema = z.object({
  name: z.string().min(1),
});

export const WorktreeTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("branch-off"),
    newBranch: z.string().min(1),
    base: z.string().min(1).optional(),
  }),
  z.object({
    mode: z.literal("checkout-branch"),
    branch: z.string().min(1),
  }),
  z.object({
    mode: z.literal("checkout-pr"),
    prNumber: z.number().int().positive(),
  }),
]);

export const DaemonEnvironmentSchema = BaseEnvironmentSchema.extend({
  kind: z.literal("daemon"),
  daemon: z.string().min(1),
  cwd: z.string().min(1),
  worktree: WorktreeTargetSchema.optional(),
});

export const FlyEnvironmentSchema = BaseEnvironmentSchema.extend({
  kind: z.literal("fly"),
  image: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

export const DockerEnvironmentSchema = BaseEnvironmentSchema.extend({
  kind: z.literal("docker"),
  image: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

export const EnvironmentSchema = z.discriminatedUnion("kind", [
  DaemonEnvironmentSchema,
  FlyEnvironmentSchema,
  DockerEnvironmentSchema,
]);

const TriggerFilterSchema = z
  .object({
    pattern: z.string().optional(),
    contains: z.string().optional(),
    repo: z.string().min(1).optional(),
    guild: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    channels: z.array(z.string().min(1)).optional(),
    from_users: z.array(z.string().min(1)).optional(),
    connection: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .optional(),
    connectionId: z.string().uuid().optional(),
    resourceId: z.string().min(1).optional(),
  })
  .strict();

const MissingFromUsersMessage =
  "trigger `name` is missing required `from_users` field, or the array is empty — at least one allowed user is required for security";

export const TriggerSchema = z
  .object({
    name: z.string().min(1),
    on: TriggerEventNameSchema,
    environment: z.string().min(1),
    agent: AgentConfigSchema,
    prompt: z.string().transform(parseTemplate),
    env: z.record(z.string().min(1), z.string().transform(parseTemplate)).optional(),
    files: z.record(z.string().min(1), z.string().transform(parseTemplate)).optional(),
    filters: TriggerFilterSchema.optional(),
    allow_outputs: z.array(AllowOutputSchema).optional(),
    timeout: TriggerTimeoutSchema.default(DEFAULT_TRIGGER_TIMEOUT),
    idle_timeout: TriggerTimeoutSchema.default(DEFAULT_TRIGGER_IDLE_TIMEOUT),
    auto_archive: z.boolean().default(false),
  })
  .superRefine((trigger, context) => {
    if (trigger.filters?.from_users !== undefined && trigger.filters.from_users.length > 0) {
      return;
    }

    context.addIssue({
      code: "custom",
      message: MissingFromUsersMessage.replace("`name`", `\`${trigger.name}\``),
      path: ["filters", "from_users"],
    });
  });

export const HubConfigSchema = z
  .object({
    environments: z.array(EnvironmentSchema).min(1),
    triggers: z.array(TriggerSchema),
  })
  .superRefine((config, context) => {
    const names = new Set<string>();
    config.triggers.forEach((trigger, index) => {
      if (names.has(trigger.name)) {
        context.addIssue({
          code: "custom",
          message: `trigger name must be unique: ${trigger.name}`,
          path: ["triggers", index, "name"],
        });
      }
      names.add(trigger.name);
    });
  });

export const ConfigRefSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("github"),
    repo: z.string().min(1),
  }),
  z.object({
    type: z.literal("local"),
    path: z.string().min(1),
  }),
]);

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AllowOutput = z.infer<typeof AllowOutputSchema>;
export type DaemonEnvironment = z.infer<typeof DaemonEnvironmentSchema>;
export type FlyEnvironment = z.infer<typeof FlyEnvironmentSchema>;
export type DockerEnvironment = z.infer<typeof DockerEnvironmentSchema>;
export type EnvironmentConfig = z.infer<typeof EnvironmentSchema>;
export type TriggerFilter = z.infer<typeof TriggerFilterSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type HubConfig = z.infer<typeof HubConfigSchema>;
export type ConfigRef = z.infer<typeof ConfigRefSchema>;
export type WorktreeTarget = z.infer<typeof WorktreeTargetSchema>;

export function parseTriggerTimeoutMs(timeout: string): number {
  const duration = readTriggerTimeout(timeout);
  if (duration === undefined) {
    throw new Error(`invalid trigger timeout: ${timeout}`);
  }

  return duration.value * timeoutMultiplier(duration.unit);
}

function readTriggerTimeout(
  timeout: string,
): { value: number; unit: TriggerTimeoutUnit } | undefined {
  const valueText = timeout.match(/^[1-9][0-9]*/u)?.[0];
  if (valueText === undefined) {
    return undefined;
  }

  const unit = timeout.slice(valueText.length);
  if (!isTriggerTimeoutUnit(unit)) {
    return undefined;
  }

  return { value: Number(valueText), unit };
}

function isTriggerTimeoutUnit(value: string): value is TriggerTimeoutUnit {
  return value === "ms" || value === "s" || value === "m" || value === "h";
}

function timeoutMultiplier(unit: TriggerTimeoutUnit): number {
  return TIMEOUT_MULTIPLIERS[unit];
}

const MERGE_VARIABLE_PATTERN = /\$\{\{\s*([^}]+?)\s*\}\}/gu;

export function parseTemplate(value: string): ParsedTemplate {
  const ast: MergeVariableAst[] = [];
  let cursor = 0;

  for (const match of value.matchAll(MERGE_VARIABLE_PATTERN)) {
    const raw = match[0];
    const expression = match[1];
    const index = match.index;

    if (expression === undefined || index === undefined) {
      continue;
    }

    if (index > cursor) {
      ast.push({ kind: "literal", value: value.slice(cursor, index) });
    }

    ast.push(parseMergeVariableExpression(raw, expression));
    cursor = index + raw.length;
  }

  if (cursor < value.length) {
    ast.push({ kind: "literal", value: value.slice(cursor) });
  }

  if (ast.length === 0) {
    ast.push({ kind: "literal", value });
  }

  return { value, ast };
}

function parseMergeVariableExpression(raw: string, expression: string): MergeVariableAst {
  const parts = expression.trim().split(".");

  if (parts[0] !== "paseo") {
    throw new Error(`unsupported merge variable: ${raw}`);
  }

  if (parts[1] === "event" && parts.length > 2) {
    return { kind: "event", path: parts.slice(2), raw };
  }

  if (
    parts[1] === "connections" &&
    parts.length === 4 &&
    parts[2] !== undefined &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(parts[2])
  ) {
    const connectionSlug = parts[2];
    const capability = parts[3];

    if (capability !== undefined && /^[a-z][a-z0-9_]*$/u.test(capability)) {
      return { kind: "connection", slug: connectionSlug, value: capability, raw };
    }
  }

  throw new Error(`unsupported merge variable: ${raw}`);
}
