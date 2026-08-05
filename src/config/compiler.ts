import { createHash } from "node:crypto";
import { z } from "zod";

const IDENTIFIER = /^[a-z][a-z0-9_-]*$/u;
const EVENT_NAME = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/u;
const DURATION = /^([1-9][0-9]*)(ms|s|m|h)$/u;
const MAX_DURATION_MS = 24 * 60 * 60_000;
const INPUT_NAME = /^[a-z][a-z0-9_-]*$/u;
const INPUT_EXPRESSION = /\$\{\{\s*paseo\.(prompt|inputs\.([a-z][a-z0-9_-]*))\s*\}\}/gu;
const DYNAMIC_INPUT_REFERENCE = /^\$\{\{\s*paseo\.inputs\.([a-z][a-z0-9_-]*)\s*\}\}$/u;

const InputValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

const AuthoredInputSchema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().optional(),
    default: InputValueSchema.optional(),
    choices: z.array(InputValueSchema).min(1).optional(),
  })
  .strict();

const AgentSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
  })
  .strict();

const PromptBlockSchema = z.object({ text: z.string() }).strict();

const AuthoredTriggerFilterSchema = z
  .object({
    pattern: z.string().optional(),
    contains: z.string().optional(),
    repo: z.string().min(1).optional(),
    guild: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    channels: z.array(z.string().min(1)).optional(),
    from_users: z.array(z.string().min(1)).optional(),
    inputs: z.record(z.string(), InputValueSchema).optional(),
    connection: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .optional(),
  })
  .strict();

const CompiledTriggerFilterSchema = AuthoredTriggerFilterSchema.extend({
  connectionId: z.string().uuid().optional(),
  resourceId: z.string().min(1).optional(),
}).superRefine((filter, context) => {
  if (filter.resourceId !== undefined && filter.connectionId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["resourceId"],
      message: "resourceId requires connectionId",
    });
  }
});

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
    environment: z.string().min(1),
    max_runtime: z.string().min(1),
    idle_timeout: z.string().min(1),
    agent: AgentSchema,
    prompt: z.array(PromptBlockSchema).min(1),
    allow_outputs: z
      .array(
        z
          .object({
            type: z.string().regex(EVENT_NAME),
            max: z.number().int().positive().optional(),
          })
          .strict(),
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
    steps: z.array(StepSchema),
    inputs: z.record(z.string(), AuthoredInputSchema).optional(),
    filters: AuthoredTriggerFilterSchema.optional(),
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

export type AuthoredEnvironment = z.infer<typeof EnvironmentSchema>;
export type AuthoredStep = z.infer<typeof StepSchema>;
export type AuthoredTrigger = z.infer<typeof AuthoredTriggerSchema>;
export type AuthoredTriggerFilter = z.infer<typeof AuthoredTriggerFilterSchema>;
export type AuthoredHubConfig = z.infer<typeof AuthoredSchema>;

export type AuthoredInput = z.infer<typeof AuthoredInputSchema>;

export interface CompiledPromptBlock {
  kind: "text";
  value: string;
}

export interface CompiledAgent {
  provider: string;
  model?: string | undefined;
  mode: string;
  thinkingOptionId?: string | undefined;
}

export interface CompiledInput {
  type: AuthoredInput["type"];
  required: boolean;
  default?: JsonPrimitive | undefined;
  choices?: readonly JsonPrimitive[] | undefined;
}

export interface CompiledStep {
  id: string;
  environment: string;
  maxRuntimeMs: number;
  idleTimeoutMs: number;
  agent: CompiledAgent;
  prompt: readonly CompiledPromptBlock[];
  allowOutputs: readonly { type: string; max: number }[];
  autoArchive: boolean;
}

export type CompiledTriggerFilter = Readonly<
  Omit<AuthoredTriggerFilter, "channels" | "from_users"> & {
    channels?: readonly string[] | undefined;
    from_users?: readonly string[] | undefined;
    inputs?: Readonly<Record<string, JsonPrimitive>> | undefined;
    connectionId?: string | undefined;
    resourceId?: string | undefined;
  }
>;

export type CompiledEnvironment =
  | (Extract<AuthoredEnvironment, { kind: "daemon" }> & { daemonId?: string | undefined })
  | Exclude<AuthoredEnvironment, { kind: "daemon" }>;

export interface CompiledTrigger {
  name: string;
  on: string;
  maxRuntimeMs: number;
  steps: readonly [CompiledStep];
  inputs: Readonly<Record<string, CompiledInput>>;
  filters?: CompiledTriggerFilter | undefined;
}

export interface CompiledHubConfig {
  environments: readonly CompiledEnvironment[];
  triggers: readonly CompiledTrigger[];
}

const CompiledPromptBlockSchema: z.ZodType<CompiledPromptBlock> = z
  .object({ kind: z.literal("text"), value: z.string() })
  .strict();

const CompiledAgentSchema: z.ZodType<CompiledAgent> = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    mode: z.string().min(1),
    thinkingOptionId: z.string().min(1).optional(),
  })
  .strict();

const CompiledInputSchema: z.ZodType<CompiledInput> = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean(),
    default: InputValueSchema.optional(),
    choices: z.array(InputValueSchema).min(1).optional(),
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
    environment: z.string().min(1),
    maxRuntimeMs: z.number().int().positive().max(MAX_DURATION_MS),
    idleTimeoutMs: z.number().int().positive().max(MAX_DURATION_MS),
    agent: CompiledAgentSchema,
    prompt: z.array(CompiledPromptBlockSchema).min(1),
    allowOutputs: z.array(
      z.object({ type: z.string().regex(EVENT_NAME), max: z.number().int().positive() }).strict(),
    ),
    autoArchive: z.boolean(),
  })
  .strict();

const CompiledTriggerSchema: z.ZodType<CompiledTrigger> = z
  .object({
    name: z.string().regex(IDENTIFIER),
    on: z.string().regex(EVENT_NAME),
    maxRuntimeMs: z.number().int().positive().max(MAX_DURATION_MS),
    steps: z.tuple([CompiledStepSchema]),
    inputs: z.record(z.string(), CompiledInputSchema),
    filters: CompiledTriggerFilterSchema.optional(),
  })
  .strict();

const CompiledHubConfigSchema: z.ZodType<CompiledHubConfig> = z
  .object({
    environments: z.array(CompiledEnvironmentSchema).min(1),
    triggers: z.array(CompiledTriggerSchema),
  })
  .strict();

export function compileHubConfig(raw: unknown): CompiledHubConfig {
  rejectRemovedFields(raw);
  const authored = AuthoredSchema.parse(raw);
  validateAuthoredIds(authored);
  const environmentNames = new Set(authored.environments.map((environment) => environment.name));
  const triggers = authored.triggers.map((trigger) => compileTrigger(trigger, environmentNames));
  const compiled = { environments: authored.environments, triggers } satisfies CompiledHubConfig;
  validateCompiledContract(compiled);
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
  validateCompiledContract(parsed.data);
  return deepFreeze(parsed.data);
}

export function compiledConfigurationHash(configuration: CompiledHubConfig): string {
  return hashConfiguration(parseCompiledHubConfig(configuration));
}

export function rawConfigurationHash(configuration: unknown): string {
  return hashConfiguration(configuration);
}

export function parseDurationMs(value: string, field: string): number {
  const match = DURATION.exec(value);
  if (match === null) {
    throw new Error(`${field} must be a positive duration such as 30s or 2h`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  let multiplier: number;
  if (unit === "ms") multiplier = 1;
  else if (unit === "s") multiplier = 1_000;
  else if (unit === "m") multiplier = 60_000;
  else multiplier = 3_600_000;
  const duration = amount * multiplier;
  if (!Number.isSafeInteger(duration) || duration > MAX_DURATION_MS) {
    throw new Error(`${field} must not exceed 24h`);
  }
  return duration;
}

function compileTrigger(
  trigger: AuthoredTrigger,
  environmentNames: ReadonlySet<string>,
): CompiledTrigger {
  if (!EVENT_NAME.test(trigger.on)) throw new Error(`invalid trigger event: ${trigger.on}`);
  if (trigger.steps.length !== 1) {
    throw new Error(`trigger ${trigger.name} must contain exactly one workflow step in Phase 2`);
  }
  const step = trigger.steps[0]!;
  const inputs = compileInputs(trigger);
  validateInputFilters(trigger, inputs);
  validateInterpolationContract(trigger, inputs);
  validateEnvironmentInputChoices(trigger, inputs, environmentNames);
  return {
    name: trigger.name,
    on: trigger.on,
    maxRuntimeMs: parseDurationMs(trigger.max_runtime, `trigger ${trigger.name} max_runtime`),
    steps: [compileStep(trigger, step, environmentNames)],
    inputs,
    ...(trigger.filters === undefined ? {} : { filters: trigger.filters }),
  };
}

function compileStep(
  trigger: AuthoredTrigger,
  step: AuthoredStep,
  environmentNames: ReadonlySet<string>,
): CompiledStep {
  if (!environmentNames.has(step.environment) && !DYNAMIC_INPUT_REFERENCE.test(step.environment)) {
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
  return {
    id: step.id,
    environment: step.environment,
    maxRuntimeMs,
    idleTimeoutMs,
    agent: { ...step.agent, mode: step.agent.mode ?? "default" },
    prompt: step.prompt.map((block) => ({ kind: "text" as const, value: block.text })),
    allowOutputs: (step.allow_outputs ?? []).map((output) => ({
      type: output.type,
      max: output.max ?? 1,
    })),
    autoArchive: step.auto_archive ?? false,
  };
}

function compileInputs(trigger: AuthoredTrigger): Readonly<Record<string, CompiledInput>> {
  const compiled: Record<string, CompiledInput> = {};
  for (const [name, input] of Object.entries(trigger.inputs ?? {})) {
    assertIdentifier(name, `input name on trigger ${trigger.name}`);
    if (input.required === true && input.default !== undefined) {
      throw new Error(
        `trigger ${trigger.name} input ${name} cannot be both required and defaulted`,
      );
    }
    if (!matchesInputType(input.default, input.type)) {
      throw new Error(`trigger ${trigger.name} input ${name} default does not match type`);
    }
    if (input.choices !== undefined) {
      if (input.choices.some((choice) => !matchesInputType(choice, input.type))) {
        throw new Error(`trigger ${trigger.name} input ${name} choices do not match type`);
      }
      if (
        input.default !== undefined &&
        !input.choices.some((choice) => choice === input.default)
      ) {
        throw new Error(`trigger ${trigger.name} input ${name} default is not an allowed choice`);
      }
    }
    compiled[name] = {
      type: input.type,
      required: input.required ?? false,
      ...(input.default === undefined ? {} : { default: input.default }),
      ...(input.choices === undefined ? {} : { choices: input.choices }),
    };
  }
  return compiled;
}

function validateInputFilters(
  trigger: AuthoredTrigger,
  inputs: Readonly<Record<string, CompiledInput>>,
): void {
  for (const [name, value] of Object.entries(trigger.filters?.inputs ?? {})) {
    const definition = inputs[name];
    if (definition === undefined) {
      throw new Error(`trigger ${trigger.name} input filter references undeclared input ${name}`);
    }
    if (!matchesInputType(value, definition.type)) {
      throw new Error(`trigger ${trigger.name} input filter ${name} does not match type`);
    }
    if (
      definition.choices !== undefined &&
      !definition.choices.some((choice) => choice === value)
    ) {
      throw new Error(`trigger ${trigger.name} input filter ${name} is not an allowed choice`);
    }
  }
}

function validateEnvironmentInputChoices(
  trigger: AuthoredTrigger,
  inputs: Readonly<Record<string, CompiledInput>>,
  environmentNames: ReadonlySet<string>,
): void {
  const reference = DYNAMIC_INPUT_REFERENCE.exec(trigger.steps[0]!.environment);
  if (reference === null) return;
  const input = inputs[reference[1]!];
  if (input === undefined || input.choices === undefined) return;
  for (const choice of input.choices) {
    if (typeof choice !== "string" || !environmentNames.has(choice)) {
      throw new Error(
        `trigger ${trigger.name} step ${trigger.steps[0]!.id} environment choice ${String(choice)} is not a configured environment`,
      );
    }
  }
}

function validateInterpolationContract(
  trigger: AuthoredTrigger,
  inputs: Readonly<Record<string, CompiledInput>>,
): void {
  const step = trigger.steps[0]!;
  validateInterpolationString(
    step.environment,
    `trigger ${trigger.name} step ${step.id} environment`,
    inputs,
    true,
  );
  validateInterpolationString(
    step.agent.provider,
    `trigger ${trigger.name} step ${step.id} agent.provider`,
    inputs,
    true,
  );
  validateInterpolationString(
    step.agent.model,
    `trigger ${trigger.name} step ${step.id} agent.model`,
    inputs,
    true,
  );
  validateInterpolationString(
    step.agent.mode,
    `trigger ${trigger.name} step ${step.id} agent.mode`,
    inputs,
    true,
  );
  validateInterpolationString(
    step.agent.thinkingOptionId,
    `trigger ${trigger.name} step ${step.id} agent.thinkingOptionId`,
    inputs,
    true,
  );
  for (const [index, block] of step.prompt.entries()) {
    validateInterpolationString(
      block.text,
      `trigger ${trigger.name} step ${step.id} prompt[${index}]`,
      inputs,
      false,
    );
  }
}

function validateCompiledInputs(trigger: CompiledTrigger): void {
  for (const [name, input] of Object.entries(trigger.inputs)) {
    if (!INPUT_NAME.test(name)) throw new Error(`invalid input name: ${name}`);
    if (!matchesInputType(input.default, input.type)) {
      throw new Error(`input ${name} default does not match type`);
    }
    if (input.required && input.default !== undefined) {
      throw new Error(`input ${name} cannot be both required and defaulted`);
    }
    if (input.choices !== undefined) {
      if (input.choices.some((choice) => !matchesInputType(choice, input.type))) {
        throw new Error(`input ${name} choices do not match type`);
      }
      if (
        input.default !== undefined &&
        !input.choices.some((choice) => choice === input.default)
      ) {
        throw new Error(`input ${name} default is not an allowed choice`);
      }
    }
  }
  for (const [name, value] of Object.entries(trigger.filters?.inputs ?? {})) {
    const input = trigger.inputs[name];
    if (input === undefined || !matchesInputType(value, input.type)) {
      throw new Error(`input filter ${name} does not match a declared input`);
    }
    if (input.choices !== undefined && !input.choices.some((choice) => choice === value)) {
      throw new Error(`input filter ${name} is not an allowed choice`);
    }
  }
}

function validateCompiledInterpolation(trigger: CompiledTrigger): void {
  const step = trigger.steps[0];
  validateInterpolationString(
    step.environment,
    `trigger ${trigger.name} step ${step.id} environment`,
    trigger.inputs,
    true,
  );
  validateInterpolationString(
    step.agent.provider,
    `trigger ${trigger.name} step ${step.id} agent.provider`,
    trigger.inputs,
    true,
  );
  validateInterpolationString(
    step.agent.model,
    `trigger ${trigger.name} step ${step.id} agent.model`,
    trigger.inputs,
    true,
  );
  validateInterpolationString(
    step.agent.mode,
    `trigger ${trigger.name} step ${step.id} agent.mode`,
    trigger.inputs,
    true,
  );
  validateInterpolationString(
    step.agent.thinkingOptionId,
    `trigger ${trigger.name} step ${step.id} agent.thinkingOptionId`,
    trigger.inputs,
    true,
  );
  for (const [index, block] of step.prompt.entries()) {
    validateInterpolationString(
      block.value,
      `trigger ${trigger.name} step ${step.id} prompt[${index}]`,
      trigger.inputs,
      false,
    );
  }
}

function validateInterpolationString(
  value: string | undefined,
  path: string,
  inputs: Readonly<Record<string, CompiledInput>>,
  authorityBearing: boolean,
): void {
  if (value === undefined) return;
  INPUT_EXPRESSION.lastIndex = 0;
  let match: RegExpExecArray | null;
  let consumed = "";
  while ((match = INPUT_EXPRESSION.exec(value)) !== null) {
    consumed += value.slice(consumed.length, match.index);
    consumed += match[0];
    const inputName = match[2];
    if (inputName !== undefined) {
      const input = inputs[inputName];
      if (input === undefined) throw new Error(`${path} references undeclared input ${inputName}`);
      if (authorityBearing && input.choices === undefined) {
        throw new Error(`${path} uses input ${inputName} without finite choices`);
      }
    }
  }
  if (consumed.length === 0) {
    if (value.includes("${{")) throw new Error(`${path} uses an unsupported expression`);
    return;
  }
  if (value.slice(consumed.length).includes("${{")) {
    throw new Error(`${path} uses an unsupported expression`);
  }
}

function matchesInputType(value: JsonPrimitive | undefined, type: AuthoredInput["type"]): boolean {
  if (value === undefined) return true;
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "boolean";
}

function validateCompiledContract(config: CompiledHubConfig): void {
  const environmentIds = new Set<string>();
  for (const environment of config.environments) {
    if (environmentIds.has(environment.name)) {
      throw new Error(`duplicate environment id: ${environment.name}`);
    }
    if (!IDENTIFIER.test(environment.name))
      throw new Error(`invalid environment name: ${environment.name}`);
    environmentIds.add(environment.name);
  }

  const triggerIds = new Set<string>();
  for (const trigger of config.triggers) {
    if (triggerIds.has(trigger.name)) throw new Error(`duplicate trigger id: ${trigger.name}`);
    triggerIds.add(trigger.name);
    if (trigger.steps.length !== 1) {
      throw new Error(`trigger ${trigger.name} must contain exactly one workflow step in Phase 2`);
    }
    const [step] = trigger.steps;
    if (!environmentIds.has(step.environment) && !DYNAMIC_INPUT_REFERENCE.test(step.environment)) {
      throw new Error(`step ${step.id} references unknown environment ${step.environment}`);
    }
    if (step.idleTimeoutMs > step.maxRuntimeMs) {
      throw new Error(`step ${step.id} idle_timeout must not exceed max_runtime`);
    }
    if (step.prompt.some((block) => block.kind !== "text")) {
      throw new Error(`step ${step.id} prompt supports inline text blocks only in Phase 2`);
    }
    validateCompiledInputs(trigger);
    validateCompiledInterpolation(trigger);
    validateTriggerLaunchSecurity(trigger);
  }
}

function validateAuthoredIds(config: AuthoredHubConfig): void {
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
    const steps = new Set<string>();
    for (const step of trigger.steps) {
      assertIdentifier(step.id, "step id");
      if (steps.has(step.id)) throw new Error(`duplicate step id: ${step.id}`);
      steps.add(step.id);
    }
  }
}

function validateTriggerLaunchSecurity(trigger: CompiledTrigger): void {
  if (trigger.on === "manual.run") return;
  if ((trigger.filters?.from_users?.length ?? 0) === 0) {
    throw new Error(
      `trigger ${trigger.name} requires a non-empty filters.from_users allowlist for externally sourced events`,
    );
  }
}

function assertIdentifier(value: string, kind: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`invalid ${kind}: ${value}`);
}

function rejectRemovedFields(raw: unknown): void {
  rejectTimeoutAnywhere(raw);
  if (!isRecord(raw)) return;
  rejectFields(raw, ["values"], "configuration");
  const triggers: unknown = raw["triggers"];
  if (!Array.isArray(triggers)) return;
  triggers.forEach((trigger: unknown, index) => rejectTriggerFields(trigger, index));
}

function rejectTriggerFields(value: unknown, index: number): void {
  if (!isRecord(value)) return;
  rejectFields(value, ["values"], `triggers[${index}]`);
  for (const field of [
    "environment",
    "agent",
    "prompt",
    "idle_timeout",
    "auto_archive",
    "allow_outputs",
  ]) {
    if (field in value) {
      throw new Error(
        `triggers[${index}].${field}: trigger-level ${field} was removed; put ${field} on the one step`,
      );
    }
  }
  const steps: unknown = value["steps"];
  if (!Array.isArray(steps)) return;
  if (steps.length !== 1) {
    throw new Error(`triggers[${index}].steps: exactly one workflow step is required in Phase 2`);
  }
  rejectStepFields(steps[0], index);
}

function rejectStepFields(value: unknown, triggerIndex: number): void {
  if (!isRecord(value)) return;
  const path = `triggers[${triggerIndex}].steps[0]`;
  for (const field of ["if", "output", "output_schema"]) {
    if (field in value) throw new Error(`${path}.${field}: ${field} is not implemented in Phase 3`);
  }
  const prompt: unknown = value["prompt"];
  if (isRecord(prompt) && "include" in prompt) {
    throw new Error(`${path}.prompt.include: prompt include blocks are not implemented in Phase 4`);
  }
  if (!Array.isArray(prompt)) return;
  prompt.forEach((block: unknown, blockIndex) => {
    if (isRecord(block) && "include" in block) {
      throw new Error(
        `${path}.prompt[${blockIndex}].include: prompt includes are not implemented in Phase 4`,
      );
    }
  });
}

function rejectFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
): void {
  for (const field of fields) {
    if (field in value) throw new Error(`${path}.${field}: ${field} is not implemented in Phase 3`);
  }
}

function rejectTimeoutAnywhere(value: unknown, path = "configuration"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectTimeoutAnywhere(child, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  if ("timeout" in value) throw new Error(`${path}.timeout: timeout was removed; use max_runtime`);
  for (const [key, child] of Object.entries(value)) rejectTimeoutAnywhere(child, `${path}.${key}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const child of value as unknown[]) deepFreeze(child);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function hashConfiguration(configuration: unknown): string {
  return createHash("sha256").update(stableJson(configuration)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "undefined";
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
