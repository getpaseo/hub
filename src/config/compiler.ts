import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

const IDENTIFIER = /^[a-z][a-z0-9_-]*$/u;
const EVENT_NAME = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/u;
const DURATION = /^([1-9][0-9]*)(ms|s|m|h)$/u;
const MAX_DURATION_MS = 24 * 60 * 60_000;

const REMOVED_TRIGGER_FIELDS = new Map([
  ["environment", "trigger-level environment was removed; put environment on a step"],
  ["agent", "trigger-level agent was removed; put agent on a step"],
  ["prompt", "trigger-level prompt was removed; put prompt on a step"],
  ["timeout", "timeout was removed; use max_runtime on the trigger or step"],
  ["idle_timeout", "trigger-level idle_timeout was removed; put idle_timeout on a step"],
  ["auto_archive", "trigger-level auto_archive was removed; put auto_archive on a step"],
  ["allow_outputs", "trigger-level allow_outputs was removed; put allow_outputs on a step"],
]);

const AgentSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
  })
  .strict();

const InputSchema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    choices: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

const PromptBlockSchema = z.union([
  z.object({ include: z.string().min(1) }).strict(),
  z.object({ text: z.string() }).strict(),
]);

const OutputSchemaDeclaration = z.object({ schema: z.unknown() }).strict();

const FilterSchema = z
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

export const WorktreeTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("branch-off"),
    newBranch: z.string().min(1),
    base: z.string().min(1).optional(),
  }),
  z.object({ mode: z.literal("checkout-branch"), branch: z.string().min(1) }),
  z.object({ mode: z.literal("checkout-pr"), prNumber: z.number().int().positive() }),
]);

const EnvironmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      name: z.string().min(1),
      kind: z.literal("daemon"),
      daemon: z.string().min(1),
      cwd: z.string().min(1),
      worktree: WorktreeTargetSchema.optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1),
      kind: z.literal("fly"),
      image: z.string().min(1),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1),
      kind: z.literal("docker"),
      image: z.string().min(1),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
]);

const StepSchema = z
  .object({
    id: z.string().min(1),
    if: z.string().min(1).optional(),
    environment: z.string().min(1),
    max_runtime: z.string().min(1),
    idle_timeout: z.string().min(1),
    agent: AgentSchema,
    prompt: z.array(PromptBlockSchema).min(1),
    output: OutputSchemaDeclaration.optional(),
    allow_outputs: z
      .array(
        z.object({ type: z.string().min(1), max: z.number().int().positive().optional() }).strict(),
      )
      .optional(),
    auto_archive: z.boolean().optional(),
  })
  .strict();

const AuthoredTriggerSchema = z
  .object({
    name: z.string().min(1),
    on: z.string().min(1),
    max_runtime: z.string().min(1),
    inputs: z.record(z.string().min(1), InputSchema).optional(),
    values: z.record(z.string().min(1), z.string().min(1)).optional(),
    steps: z.array(StepSchema).min(1),
    filters: FilterSchema.optional(),
  })
  .strict();

const AuthoredSchema = z
  .object({
    environments: z.array(EnvironmentSchema).min(1),
    triggers: z.array(AuthoredTriggerSchema),
  })
  .strict();

export const HubConfigSchema = AuthoredSchema;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type AuthoredInputDefinition = z.infer<typeof InputSchema>;
export type AuthoredEnvironment = z.infer<typeof EnvironmentSchema>;
export type AuthoredStep = z.infer<typeof StepSchema>;
export type AuthoredTrigger = z.infer<typeof AuthoredTriggerSchema>;
export type AuthoredHubConfig = z.infer<typeof AuthoredSchema>;

export type ExpressionAst =
  | { kind: "path"; path: readonly string[] }
  | { kind: "literal"; value: JsonValue }
  | { kind: "unary"; operator: "!"; operand: ExpressionAst }
  | {
      kind: "binary";
      operator: "==" | "!=" | "&&" | "||" | "??";
      left: ExpressionAst;
      right: ExpressionAst;
    };

export type PromptExpressionPart =
  | { kind: "literal"; value: string }
  | { kind: "expression"; expression: ExpressionAst };

export type CompiledPromptBlock =
  | { kind: "include"; path: string }
  | { kind: "text"; value: string; ast: readonly PromptExpressionPart[] };

export interface CompiledInputDefinition {
  type: AuthoredInputDefinition["type"];
  required: boolean;
  default?: JsonPrimitive | undefined;
  choices?: readonly JsonPrimitive[] | undefined;
}

export interface CompiledAgent {
  provider: string | ExpressionAst;
  model?: string | ExpressionAst | undefined;
  mode?: string | ExpressionAst | undefined;
  thinkingOptionId?: string | ExpressionAst | undefined;
}

export type JsonSchemaContract = boolean | { readonly [key: string]: JsonValue };

export interface CompiledStep {
  id: string;
  if?: ExpressionAst | undefined;
  environment: string;
  maxRuntimeMs: number;
  idleTimeoutMs: number;
  agent: CompiledAgent;
  prompt: readonly CompiledPromptBlock[];
  outputSchema?: JsonSchemaContract | undefined;
  allowOutputs: readonly { type: string; max: number }[];
  autoArchive: boolean;
}

export interface CompiledTrigger {
  name: string;
  on: string;
  maxRuntimeMs: number;
  inputs: Readonly<Record<string, CompiledInputDefinition>>;
  values: Readonly<Record<string, ExpressionAst>>;
  steps: readonly CompiledStep[];
  filters?: AuthoredTrigger["filters"] | undefined;
}

export type CompiledEnvironment =
  | (Extract<AuthoredEnvironment, { kind: "daemon" }> & { daemonId?: string | undefined })
  | Exclude<AuthoredEnvironment, { kind: "daemon" }>;

export interface CompiledHubConfig {
  environments: readonly CompiledEnvironment[];
  triggers: readonly CompiledTrigger[];
}

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const ExpressionAstSchema: z.ZodType<ExpressionAst> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("path"), path: z.array(z.string().min(1)) }).strict(),
    z.object({ kind: z.literal("literal"), value: JsonValueSchema }).strict(),
    z
      .object({ kind: z.literal("unary"), operator: z.literal("!"), operand: ExpressionAstSchema })
      .strict(),
    z
      .object({
        kind: z.literal("binary"),
        operator: z.enum(["==", "!=", "&&", "||", "??"]),
        left: ExpressionAstSchema,
        right: ExpressionAstSchema,
      })
      .strict(),
  ]),
);

const CompiledPromptExpressionPartSchema: z.ZodType<PromptExpressionPart> = z.union([
  z.object({ kind: z.literal("literal"), value: z.string() }).strict(),
  z.object({ kind: z.literal("expression"), expression: ExpressionAstSchema }).strict(),
]);

const CompiledPromptBlockSchema: z.ZodType<CompiledPromptBlock> = z.union([
  z.object({ kind: z.literal("include"), path: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("text"),
      value: z.string(),
      ast: z.array(CompiledPromptExpressionPartSchema),
    })
    .strict(),
]);

const CompiledInputDefinitionSchema: z.ZodType<CompiledInputDefinition> = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean(),
    default: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]).optional(),
    choices: z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).optional(),
  })
  .strict();

const CompiledExpressionValueSchema = z.union([z.string().min(1), ExpressionAstSchema]);
const CompiledAgentSchema: z.ZodType<CompiledAgent> = z
  .object({
    provider: CompiledExpressionValueSchema,
    model: CompiledExpressionValueSchema.optional(),
    mode: CompiledExpressionValueSchema.optional(),
    thinkingOptionId: CompiledExpressionValueSchema.optional(),
  })
  .strict();

const CompiledEnvironmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      name: z.string().regex(IDENTIFIER),
      kind: z.literal("daemon"),
      daemon: z.string().min(1),
      daemonId: z.string().min(1).optional(),
      cwd: z.string().min(1),
      worktree: WorktreeTargetSchema.optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().regex(IDENTIFIER),
      kind: z.literal("fly"),
      image: z.string().min(1),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().regex(IDENTIFIER),
      kind: z.literal("docker"),
      image: z.string().min(1),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
]);

const CompiledStepSchema: z.ZodType<CompiledStep> = z
  .object({
    id: z.string().regex(IDENTIFIER),
    if: ExpressionAstSchema.optional(),
    environment: z.string().min(1),
    maxRuntimeMs: z.number().int().positive().max(MAX_DURATION_MS),
    idleTimeoutMs: z.number().int().positive().max(MAX_DURATION_MS),
    agent: CompiledAgentSchema,
    prompt: z.array(CompiledPromptBlockSchema).min(1),
    outputSchema: z.union([z.boolean(), z.record(z.string(), JsonValueSchema)]).optional(),
    allowOutputs: z.array(
      z.object({ type: z.string().min(1), max: z.number().int().positive() }).strict(),
    ),
    autoArchive: z.boolean(),
  })
  .strict();

const CompiledTriggerSchema: z.ZodType<CompiledTrigger> = z
  .object({
    name: z.string().regex(IDENTIFIER),
    on: z.string().regex(EVENT_NAME),
    maxRuntimeMs: z.number().int().positive().max(MAX_DURATION_MS),
    inputs: z.record(z.string().regex(IDENTIFIER), CompiledInputDefinitionSchema),
    values: z.record(z.string().regex(IDENTIFIER), ExpressionAstSchema),
    steps: z.array(CompiledStepSchema).min(1),
    filters: FilterSchema.optional(),
  })
  .strict();

const CompiledHubConfigSchema: z.ZodType<CompiledHubConfig> = z
  .object({
    environments: z.array(CompiledEnvironmentSchema).min(1),
    triggers: z.array(CompiledTriggerSchema),
  })
  .strict();

const jsonSchemaCompiler = new Ajv2020({ allErrors: true, strict: true });

export function compileHubConfig(raw: unknown): CompiledHubConfig {
  rejectRemovedFields(raw);
  const authored = AuthoredSchema.parse(raw);
  validateIds(authored);

  const environmentNames = new Set(authored.environments.map((environment) => environment.name));
  const triggers = authored.triggers.map((trigger) => compileTrigger(trigger, environmentNames));
  const compiled = { environments: authored.environments, triggers } satisfies CompiledHubConfig;
  validateReferences(compiled);
  return deepFreeze(compiled);
}

export function parseCompiledHubConfig(value: unknown): CompiledHubConfig {
  let cloned: unknown;
  try {
    cloned = structuredClone(value);
  } catch {
    throw new Error("active configuration contains an invalid compiled workflow contract");
  }
  const parsed = CompiledHubConfigSchema.safeParse(cloned);
  if (!parsed.success) {
    throw new Error("active configuration contains an invalid compiled workflow contract");
  }
  for (const trigger of parsed.data.triggers) {
    for (const step of trigger.steps) {
      if (step.outputSchema !== undefined) {
        validateJsonSchema(step.outputSchema, `step ${step.id} output.schema`);
      }
    }
  }
  const environmentNames = new Set(parsed.data.environments.map((environment) => environment.name));
  for (const trigger of parsed.data.triggers) {
    for (const step of trigger.steps) {
      if (!environmentNames.has(step.environment)) {
        throw new Error(`active configuration contains an unknown environment ${step.environment}`);
      }
      if (step.idleTimeoutMs > step.maxRuntimeMs) {
        throw new Error(`active configuration contains an invalid step timeout relationship`);
      }
    }
  }
  validateReferences(parsed.data);
  return deepFreeze(parsed.data);
}

export function compiledConfigurationHash(configuration: unknown): string {
  return createHash("sha256").update(stableJson(configuration)).digest("hex");
}

export function parseDurationMs(value: string, field: string): number {
  const match = DURATION.exec(value);
  if (match === null) {
    throw new Error(`${field} must be a positive duration such as 30s or 2h`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  let multiplier = 3_600_000;
  if (unit === "ms") multiplier = 1;
  else if (unit === "s") multiplier = 1_000;
  else if (unit === "m") multiplier = 60_000;
  const duration = amount * multiplier;
  if (!Number.isSafeInteger(duration) || duration > MAX_DURATION_MS) {
    throw new Error(`${field} must not exceed 24h`);
  }
  return duration;
}

export function parseExpression(source: string, field = "expression"): ExpressionAst {
  const expression = unwrapExpression(source, field);
  const parser = new ExpressionParser(expression, field);
  return parser.parse();
}

export function parsePromptText(
  source: string,
  field: string,
): {
  value: string;
  ast: readonly PromptExpressionPart[];
} {
  const ast: PromptExpressionPart[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("${{", cursor);
    if (start < 0) {
      if (cursor < source.length) ast.push({ kind: "literal", value: source.slice(cursor) });
      break;
    }
    if (start > cursor) ast.push({ kind: "literal", value: source.slice(cursor, start) });
    const end = source.indexOf("}}", start + 3);
    if (end < 0) throw new Error(`${field} contains an unterminated expression`);
    ast.push({
      kind: "expression",
      expression: parseExpression(source.slice(start, end + 2), `${field} expression`),
    });
    cursor = end + 2;
  }
  if (ast.length === 0) ast.push({ kind: "literal", value: source });
  return { value: source, ast: deepFreeze(ast) };
}

function compileTrigger(
  trigger: AuthoredTrigger,
  environmentNames: ReadonlySet<string>,
): CompiledTrigger {
  if (!EVENT_NAME.test(trigger.on)) throw new Error(`invalid trigger event: ${trigger.on}`);
  const maxRuntimeMs = parseDurationMs(trigger.max_runtime, `trigger ${trigger.name} max_runtime`);
  const inputs = compileInputs(trigger);
  const values = Object.fromEntries(
    Object.entries(trigger.values ?? {}).map(([name, source]) => [
      name,
      parseExpression(source, `trigger ${trigger.name} value ${name}`),
    ]),
  );
  const steps = trigger.steps.map((step) => compileStep(trigger, step, environmentNames));
  return {
    name: trigger.name,
    on: trigger.on,
    maxRuntimeMs,
    inputs,
    values,
    steps,
    ...(trigger.filters === undefined ? {} : { filters: trigger.filters }),
  };
}

function compileInputs(
  trigger: AuthoredTrigger,
): Readonly<Record<string, CompiledInputDefinition>> {
  const entries = Object.entries(trigger.inputs ?? {}).map(([name, definition]) => {
    if (isAuthorityBearingInput(name) && definition.choices === undefined) {
      throw new Error(`input ${name} is authority-bearing and must declare finite choices`);
    }
    const required = definition.required ?? false;
    if (required && definition.default !== undefined) {
      throw new Error(`input ${name} cannot be required and have a default`);
    }
    if (
      definition.default !== undefined &&
      !matchesInputType(definition.type, definition.default)
    ) {
      throw new Error(`input ${name} default does not match type ${definition.type}`);
    }
    if (definition.choices !== undefined) {
      if (definition.choices.length === 0)
        throw new Error(`input ${name} choices must not be empty`);
      const seen = new Set<string>();
      for (const choice of definition.choices) {
        if (!matchesInputType(definition.type, choice)) {
          throw new Error(`input ${name} choices must match type ${definition.type}`);
        }
        const key = JSON.stringify(choice);
        if (seen.has(key)) throw new Error(`input ${name} choices must be unique`);
        seen.add(key);
      }
      if (
        definition.default !== undefined &&
        !definition.choices.some((choice) => Object.is(choice, definition.default))
      ) {
        throw new Error(`input ${name} default must be one of its choices`);
      }
    }
    return [
      name,
      {
        type: definition.type,
        required,
        ...(definition.default === undefined ? {} : { default: definition.default }),
        ...(definition.choices === undefined ? {} : { choices: definition.choices }),
      },
    ] as const;
  });
  return Object.fromEntries(entries);
}

function compileStep(
  trigger: AuthoredTrigger,
  step: AuthoredStep,
  environmentNames: ReadonlySet<string>,
): CompiledStep {
  if (!environmentNames.has(step.environment)) {
    throw new Error(`step ${step.id} references unknown environment ${step.environment}`);
  }
  const maxRuntimeMs = parseDurationMs(
    step.max_runtime,
    `trigger ${trigger.name} step ${step.id} max_runtime`,
  );
  const idleTimeoutMs = parseDurationMs(
    step.idle_timeout,
    `trigger ${trigger.name} step ${step.id} idle_timeout`,
  );
  if (idleTimeoutMs > maxRuntimeMs) {
    throw new Error(`step ${step.id} idle_timeout must not exceed max_runtime`);
  }
  const prompt = step.prompt.map((block, index) => {
    if ("include" in block) {
      validatePartialPath(block.include, `step ${step.id} prompt block ${index}`);
      return { kind: "include" as const, path: block.include };
    }
    const parsed = parsePromptText(block.text, `step ${step.id} prompt block ${index}`);
    return { kind: "text" as const, value: parsed.value, ast: parsed.ast };
  });
  const agent: CompiledAgent = {
    provider: compileAgentValue(step.agent.provider, `step ${step.id} agent.provider`),
  };
  if (step.agent.model !== undefined)
    agent.model = compileAgentValue(step.agent.model, `step ${step.id} agent.model`);
  if (step.agent.mode !== undefined)
    agent.mode = compileAgentValue(step.agent.mode, `step ${step.id} agent.mode`);
  if (step.agent.thinkingOptionId !== undefined)
    agent.thinkingOptionId = compileAgentValue(
      step.agent.thinkingOptionId,
      `step ${step.id} agent.thinkingOptionId`,
    );
  return {
    id: step.id,
    ...(step.if === undefined ? {} : { if: parseExpression(step.if, `step ${step.id} if`) }),
    environment: step.environment,
    maxRuntimeMs,
    idleTimeoutMs,
    agent,
    prompt,
    ...(step.output === undefined
      ? {}
      : { outputSchema: validateJsonSchema(step.output.schema, `step ${step.id} output.schema`) }),
    allowOutputs: (step.allow_outputs ?? []).map((output) => ({
      type: output.type,
      max: output.max ?? 1,
    })),
    autoArchive: step.auto_archive ?? false,
  };
}

function compileAgentValue(value: string, field: string): string | ExpressionAst {
  return isExpression(value) ? parseExpression(value, field) : value;
}

function validateReferences(config: CompiledHubConfig): void {
  for (const trigger of config.triggers) {
    const stepOrdinals = new Map(trigger.steps.map((step, index) => [step.id, index]));
    for (const [name, expression] of Object.entries(trigger.values)) {
      walkExpression(expression, (path) =>
        validatePath(path, trigger, stepOrdinals, `value ${name}`),
      );
    }
    for (const [index, step] of trigger.steps.entries()) {
      if (step.if !== undefined) {
        validateExpressionAtStep(step.if, trigger, stepOrdinals, index, `step ${step.id} if`);
      }
      validatePromptReferences(step, trigger, stepOrdinals, index);
      validateAgentReferences(step, trigger, stepOrdinals, index);
    }
    detectValueCycles(trigger);
  }
}

function validatePromptReferences(
  step: CompiledStep,
  trigger: CompiledTrigger,
  stepOrdinals: ReadonlyMap<string, number>,
  index: number,
): void {
  for (const block of step.prompt) {
    if (block.kind !== "text") continue;
    for (const part of block.ast) {
      if (part.kind !== "expression") continue;
      validateExpressionAtStep(
        part.expression,
        trigger,
        stepOrdinals,
        index,
        `step ${step.id} prompt`,
      );
    }
  }
}

function validateAgentReferences(
  step: CompiledStep,
  trigger: CompiledTrigger,
  stepOrdinals: ReadonlyMap<string, number>,
  index: number,
): void {
  const values = [
    step.agent.provider,
    step.agent.model,
    step.agent.mode,
    step.agent.thinkingOptionId,
  ];
  for (const value of values) {
    if (value === undefined || typeof value === "string") continue;
    validateExpressionAtStep(value, trigger, stepOrdinals, index, `step ${step.id} agent`);
  }
}

function validateExpressionAtStep(
  expression: ExpressionAst,
  trigger: CompiledTrigger,
  stepOrdinals: ReadonlyMap<string, number>,
  currentOrdinal: number,
  field: string,
): void {
  const visitingValues = new Set<string>();
  const visit = (current: ExpressionAst, currentField: string): void => {
    walkExpression(current, (path) => {
      validatePath(path, trigger, stepOrdinals, currentField);
      if (path[0] === "steps") {
        const referencedStep = stepOrdinals.get(path[1]!);
        if (referencedStep !== undefined && referencedStep >= currentOrdinal) {
          throw new Error(`${field} contains a forward step reference to ${path[1]}`);
        }
      }
      if (path[0] === "values") {
        const valueName = path[1]!;
        if (visitingValues.has(valueName)) return;
        const valueExpression = trigger.values[valueName];
        if (valueExpression === undefined) return;
        visitingValues.add(valueName);
        visit(valueExpression, `${field} through values.${valueName}`);
        visitingValues.delete(valueName);
      }
    });
  };
  visit(expression, field);
}

function validatePath(
  path: readonly string[],
  trigger: CompiledTrigger,
  stepOrdinals: ReadonlyMap<string, number>,
  field: string,
): void {
  if (path[0] === "paseo" && path[1] === "inputs" && path.length === 3) {
    const input = trigger.inputs[path[2]!];
    if (input === undefined) throw new Error(`${field} references unknown input ${path[2]}`);
    if (field.includes(" agent") && input.choices === undefined) {
      throw new Error(`${field} uses authority-bearing input ${path[2]} without finite choices`);
    }
    return;
  }
  if (path.length === 2 && path[0] === "paseo" && path[1] === "prompt") return;
  if (path[0] === "values" && path.length === 2) {
    if (!(path[1]! in trigger.values))
      throw new Error(`${field} references unknown value ${path[1]}`);
    return;
  }
  if (path[0] === "steps" && path[2] === "outputs" && path.length >= 4) {
    const stepId = path[1]!;
    const ordinal = stepOrdinals.get(stepId);
    if (ordinal === undefined) throw new Error(`${field} references unknown step ${stepId}`);
    const step = trigger.steps[ordinal];
    if (step?.outputSchema === undefined)
      throw new Error(
        `${field} references output of step ${stepId}, which declares no output schema`,
      );
    if (!outputPathExists(step.outputSchema, path.slice(3))) {
      throw new Error(`${field} references unknown output ${stepId}.${path.slice(3).join(".")}`);
    }
    return;
  }
  throw new Error(`${field} contains unsupported expression path ${path.join(".")}`);
}

function detectValueCycles(trigger: CompiledTrigger): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) throw new Error(`value dependency cycle includes ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    const expression = trigger.values[name];
    if (expression !== undefined) {
      walkExpression(expression, (path) => {
        if (path[0] === "values" && path[1] !== undefined) visit(path[1]);
      });
    }
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of Object.keys(trigger.values)) visit(name);
}

function outputPathExists(schema: JsonSchemaContract, path: readonly string[]): boolean {
  let current: JsonSchemaContract = schema;
  for (const segment of path) {
    if (typeof current === "boolean") return current;
    const properties = current["properties"];
    if (isRecord(properties) && isJsonSchemaContract(properties[segment])) {
      current = properties[segment];
      continue;
    }
    const additionalProperties = current["additionalProperties"];
    if (additionalProperties === true) return true;
    if (isJsonSchemaContract(additionalProperties)) {
      current = additionalProperties;
      continue;
    }
    return false;
  }
  return typeof current !== "boolean" || current;
}

function validateJsonSchema(value: unknown, field: string): JsonSchemaContract {
  if (!isJsonSchemaContract(value)) throw new Error(`${field} must be a JSON Schema`);
  try {
    jsonSchemaCompiler.compile(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON Schema";
    throw new Error(`${field} is invalid JSON Schema: ${message}`, { cause: error });
  }
  return structuredClone(value);
}

function validateIds(config: AuthoredHubConfig): void {
  const environments = new Set<string>();
  for (const environment of config.environments) {
    assertIdentifier(environment.name, "environment name");
    if (environments.has(environment.name))
      throw new Error(`duplicate environment id: ${environment.name}`);
    environments.add(environment.name);
  }
  const triggers = new Set<string>();
  for (const trigger of config.triggers) {
    assertIdentifier(trigger.name, "trigger name");
    if (triggers.has(trigger.name)) throw new Error(`duplicate trigger id: ${trigger.name}`);
    triggers.add(trigger.name);
    for (const name of Object.keys(trigger.inputs ?? {})) assertIdentifier(name, "input id");
    for (const name of Object.keys(trigger.values ?? {})) assertIdentifier(name, "value id");
    const steps = new Set<string>();
    for (const step of trigger.steps) {
      assertIdentifier(step.id, "step id");
      if (steps.has(step.id)) throw new Error(`duplicate step id: ${step.id}`);
      steps.add(step.id);
    }
  }
}

function assertIdentifier(value: string, kind: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`invalid ${kind}: ${value}`);
}

function validatePartialPath(value: string, field: string): void {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`${field} include path must stay inside .paseo/partials`);
  }
}

function isAuthorityBearingInput(name: string): boolean {
  return /^(?:repo|repository|connection|environment|provider|model|mode|agent)$/iu.test(name);
}

function matchesInputType(type: AuthoredInputDefinition["type"], value: JsonPrimitive): boolean {
  return (
    (type === "string" && typeof value === "string") ||
    (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (type === "boolean" && typeof value === "boolean")
  );
}

function rejectRemovedFields(raw: unknown): void {
  if (!isRecord(raw) || !Array.isArray(raw["triggers"])) return;
  for (const [index, trigger] of raw["triggers"].entries()) {
    if (!isRecord(trigger)) continue;
    for (const [field, hint] of REMOVED_TRIGGER_FIELDS) {
      if (field in trigger) throw new Error(`triggers[${index}].${field}: ${hint}`);
    }
  }
}

function isExpression(value: string): boolean {
  return value.trimStart().startsWith("${{");
}

function unwrapExpression(source: string, field: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith("${{") || !trimmed.endsWith("}}")) {
    throw new Error(`${field} must be a complete \${{ ... }} expression`);
  }
  const body = trimmed.slice(3, -2).trim();
  if (body.length === 0) throw new Error(`${field} must not be empty`);
  return body;
}

function walkExpression(expression: ExpressionAst, visit: (path: readonly string[]) => void): void {
  switch (expression.kind) {
    case "path":
      visit(expression.path);
      return;
    case "literal":
      return;
    case "unary":
      walkExpression(expression.operand, visit);
      return;
    case "binary":
      walkExpression(expression.left, visit);
      walkExpression(expression.right, visit);
      return;
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonSchemaContract(value: unknown): value is JsonSchemaContract {
  return typeof value === "boolean" || isJsonObject(value);
}

function isJsonObject(value: unknown): value is { readonly [key: string]: JsonValue } {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "undefined";
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

type Operator = "(" | ")" | "!" | "==" | "!=" | "&&" | "||" | "??";

type Token =
  | { kind: "operator"; value: Operator }
  | { kind: "literal"; value: JsonValue }
  | { kind: "identifier"; value: string }
  | { kind: "dot" };

class ExpressionParser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(
    source: string,
    private readonly field: string,
  ) {
    this.tokens = tokenize(source, field);
  }

  parse(): ExpressionAst {
    const expression = this.parseOr();
    if (this.index !== this.tokens.length)
      throw new Error(`${this.field} contains an unexpected token`);
    return expression;
  }

  private parseOr(): ExpressionAst {
    let left = this.parseNullish();
    while (this.takeOperator("||"))
      left = { kind: "binary", operator: "||", left, right: this.parseNullish() };
    return left;
  }

  private parseNullish(): ExpressionAst {
    let left = this.parseAnd();
    while (this.takeOperator("??"))
      left = { kind: "binary", operator: "??", left, right: this.parseAnd() };
    return left;
  }

  private parseAnd(): ExpressionAst {
    let left = this.parseEquality();
    while (this.takeOperator("&&"))
      left = { kind: "binary", operator: "&&", left, right: this.parseEquality() };
    return left;
  }

  private parseEquality(): ExpressionAst {
    let left = this.parseUnary();
    while (true) {
      let operator: "==" | "!=" | undefined;
      if (this.takeOperator("==")) operator = "==";
      else if (this.takeOperator("!=")) operator = "!=";
      if (operator === undefined) return left;
      left = { kind: "binary", operator, left, right: this.parseUnary() };
    }
  }

  private parseUnary(): ExpressionAst {
    if (this.takeOperator("!")) return { kind: "unary", operator: "!", operand: this.parseUnary() };
    if (this.takeOperator("(")) {
      const expression = this.parseOr();
      this.expectOperator(")");
      return expression;
    }
    const token = this.tokens[this.index++];
    if (token?.kind === "literal") return { kind: "literal", value: token.value };
    if (token?.kind === "identifier") {
      const path = [token.value];
      while (this.takeDot()) {
        const segment = this.tokens[this.index++];
        if (segment?.kind !== "identifier")
          throw new Error(`${this.field} contains an invalid path`);
        path.push(segment.value);
      }
      return { kind: "path", path };
    }
    throw new Error(`${this.field} expected a literal, path, or parenthesized expression`);
  }

  private takeDot(): boolean {
    if (this.tokens[this.index]?.kind !== "dot") return false;
    this.index += 1;
    return true;
  }

  private takeOperator(value: Operator): boolean {
    const token = this.tokens[this.index];
    if (token?.kind !== "operator" || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private expectOperator(value: Operator): void {
    if (!this.takeOperator(value)) throw new Error(`${this.field} expected ${value}`);
  }
}

type BinaryOperator = Exclude<Operator, "(" | ")" | "!">;
interface TokenRead {
  token: Token;
  nextIndex: number;
}

const TWO_CHARACTER_OPERATORS: Readonly<Record<string, BinaryOperator>> = {
  "==": "==",
  "!=": "!=",
  "&&": "&&",
  "||": "||",
  "??": "??",
};

function tokenize(source: string, field: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === undefined) break;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    const read = readToken(source, index, field);
    tokens.push(read.token);
    index = read.nextIndex;
  }
  return tokens;
}

function readToken(source: string, index: number, field: string): TokenRead {
  const character = source[index];
  if (character === undefined) throw new Error(`${field} contains an unexpected end`);
  const operator = TWO_CHARACTER_OPERATORS[source.slice(index, index + 2)];
  if (operator !== undefined)
    return { token: { kind: "operator", value: operator }, nextIndex: index + 2 };
  if (character === "(" || character === ")" || character === "!") {
    return { token: { kind: "operator", value: character }, nextIndex: index + 1 };
  }
  if (character === ".") return { token: { kind: "dot" }, nextIndex: index + 1 };
  if (character === "[" || character === "{") return readJsonToken(source, index, field);
  if (character === '"' || character === "'") return readStringToken(source, index, field);
  const number = source
    .slice(index)
    .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
  if (number !== undefined) {
    return { token: { kind: "literal", value: Number(number) }, nextIndex: index + number.length };
  }
  const identifier = source.slice(index).match(/^[a-zA-Z_][a-zA-Z0-9_-]*/u)?.[0];
  if (identifier !== undefined) return readIdentifier(identifier, index);
  throw new Error(`${field} contains an unsupported token near ${source.slice(index)}`);
}

function readIdentifier(identifier: string, index: number): TokenRead {
  let token: Token;
  if (identifier === "true" || identifier === "false")
    token = { kind: "literal", value: identifier === "true" };
  else if (identifier === "null") token = { kind: "literal", value: null };
  else token = { kind: "identifier", value: identifier };
  return { token, nextIndex: index + identifier.length };
}

function readJsonToken(source: string, index: number, field: string): TokenRead {
  const end = findJsonLiteralEnd(source, index, field);
  let value: unknown;
  try {
    value = JSON.parse(source.slice(index, end));
  } catch {
    throw new Error(`${field} contains an invalid JSON literal`);
  }
  if (!isJsonValue(value)) throw new Error(`${field} contains an invalid JSON literal`);
  return { token: { kind: "literal", value }, nextIndex: end };
}

function readStringToken(source: string, index: number, field: string): TokenRead {
  const quote = source[index];
  if (quote !== '"' && quote !== "'")
    throw new Error(`${field} contains an invalid string literal`);
  let end = index + 1;
  let escaped = false;
  let value = "";
  for (; end < source.length; end += 1) {
    const current = source[end];
    if (current === undefined) break;
    if (escaped) {
      value += decodeEscapedCharacter(current);
      escaped = false;
    } else if (current === "\\") escaped = true;
    else if (current === quote) break;
    else value += current;
  }
  if (source[end] !== quote) throw new Error(`${field} contains an unterminated string literal`);
  if (quote === '"') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.slice(index, end + 1));
    } catch {
      throw new Error(`${field} contains an invalid string literal`);
    }
    if (!isJsonValue(parsed)) throw new Error(`${field} contains an invalid string literal`);
    return { token: { kind: "literal", value: parsed }, nextIndex: end + 1 };
  }
  return { token: { kind: "literal", value }, nextIndex: end + 1 };
}

function decodeEscapedCharacter(character: string): string {
  if (character === "n") return "\n";
  if (character === "r") return "\r";
  if (character === "t") return "\t";
  return character;
}

function findJsonLiteralEnd(source: string, start: number, field: string): number {
  const opening = source[start];
  const stack = [opening];
  let quote: '"' | undefined;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === "[" || character === "{") {
      stack.push(character);
      continue;
    }
    if (character === "]" || character === "}") {
      const expected = character === "]" ? "[" : "{";
      if (stack.at(-1) !== expected) throw new Error(`${field} contains an invalid JSON literal`);
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  throw new Error(`${field} contains an unterminated JSON literal`);
}
