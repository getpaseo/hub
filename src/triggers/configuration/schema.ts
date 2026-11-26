import { RecurrenceSchema } from "../schedule/recurrence.js";
import { z } from "zod";
import { buildIntegrationToolGrantsSchema } from "../../integration-tools/grants.js";
import {
  defaultIntegrationRegistry,
  type IntegrationRegistry,
} from "../../integrations/registry.js";
import { ContinuationSchema } from "../continuation.js";
import { eventDefinition, isEditorEvent } from "./events.js";
import { AuthoredGitHubAuthoritySchema } from "../../config/github-authority.js";
import { GitHubAuthorAssociationSchema } from "../github/author-association.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const WorktreeTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("branch-off"),
    newBranch: z.string().min(1),
    base: z.string().min(1).optional(),
  }),
  z.object({ mode: z.literal("checkout-branch"), branch: z.string().min(1) }),
  z.object({ mode: z.literal("checkout-pr"), prNumber: z.number().int().positive() }),
]);

/** A trigger or choice name: the document's own alphabet, shared with the form that writes one. */
export const IDENTIFIER = /^[a-z][a-z0-9_-]*$/u;
const EVENT_NAME = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/u;
const CONNECTION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const InputValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const TriggerInputSchema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().optional(),
    default: InputValueSchema.optional(),
    choices: z.array(InputValueSchema).min(1).optional(),
  })
  .strict();

const TriggerFilterObjectSchema = z.object({
  pattern: z.string().optional(),
  contains: z.string().optional(),
  /** GitHub text which makes an event ineligible, such as a command another trigger owns. */
  exclude_contains: z.string().optional(),
  label: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).min(1).optional(),
  repo: z.string().min(1).optional(),
  guild: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  states: z.array(z.string().min(1)).min(1).optional(),
  exclude_labels: z.array(z.string().min(1)).min(1).optional(),
  assignees: z.array(z.string().min(1)).min(1).optional(),
  channels: z.array(z.string().min(1)).optional(),
  from_users: z.array(z.string().min(1)).optional(),
  /** GitHub repository associations whose holders may invoke the trigger. */
  author_associations: z.array(GitHubAuthorAssociationSchema).min(1).optional(),
  inputs: z.record(z.string(), InputValueSchema).optional(),
});

export const TriggerFilterSchema = TriggerFilterObjectSchema.strict();
const AnyTriggerFilterSchema = TriggerFilterObjectSchema.catchall(z.unknown());

export type TriggerFilter = z.infer<typeof AnyTriggerFilterSchema>;

export const TriggerEventSchema = z
  .object({
    recurrence: RecurrenceSchema.optional(),
    connection: z.string().regex(CONNECTION_SLUG).optional(),
    filters: AnyTriggerFilterSchema.optional(),
  })
  .strict();

export const TriggerAgentSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
    options: z.record(z.string(), z.custom<JsonValue>()).optional(),
  })
  .strict();

export const TriggerAgentSelectionSchema = z.union([
  TriggerAgentSchema,
  z
    .object({
      select: z.string().min(1),
      choices: z.record(z.string().regex(IDENTIFIER), TriggerAgentSchema),
    })
    .strict(),
]);

export const TriggerTargetSchema = z
  .object({
    daemon: z.string().min(1),
    cwd: z.string().min(1),
    worktree: WorktreeTargetSchema.optional(),
  })
  .strict();

export const TriggerOutputSchema = z
  .object({
    max: z.number().int().positive().optional(),
    required: z.boolean().optional(),
  })
  .strict();

function buildTriggerRunSchema(registry: IntegrationRegistry) {
  return z
    .object({
      target: TriggerTargetSchema,
      agent: TriggerAgentSelectionSchema,
      continuation: ContinuationSchema.default({ mode: "conversation" }),
      /** Workspace title template: literal text plus `${{ paseo.execution.id }}`. */
      title: z.string().min(1).optional(),
      prompt: z.string().min(1),
      max_runtime: z.string().min(1).default("2h"),
      idle_timeout: z.string().min(1).default("10m"),
      startup_timeout: z.string().min(1).optional(),
      env: z.record(z.string().min(1), z.string()).optional(),
      github: AuthoredGitHubAuthoritySchema.optional(),
      tools: buildIntegrationToolGrantsSchema(registry).optional(),
      output: z
        .object({ schema: z.record(z.string(), z.unknown()) })
        .strict()
        .optional(),
      outputs: z.record(z.string().regex(EVENT_NAME), TriggerOutputSchema).optional(),
      auto_archive: z.boolean().default(true),
      background: z.boolean().default(false),
    })
    .strict();
}

export const TriggerRunSchema = buildTriggerRunSchema(defaultIntegrationRegistry);

export function buildTriggerDocumentSchema(
  registry: IntegrationRegistry = defaultIntegrationRegistry,
) {
  return z
    .object({
      name: z.string().regex(IDENTIFIER),
      enabled: z.boolean().default(true),
      on: z.record(z.string().regex(EVENT_NAME), TriggerEventSchema),
      inputs: z.record(z.string().regex(IDENTIFIER), TriggerInputSchema).optional(),
      /** A distinct whole-trigger deadline; new one-run triggers normally omit it. */
      max_runtime: z.string().min(1).optional(),
      run: buildTriggerRunSchema(registry),
    })
    .strict()
    .superRefine((trigger, context) => {
      for (const [event, definition] of Object.entries(trigger.on)) {
        validateTriggerEventEntry(event, definition, trigger.inputs, registry, context);
      }
      if (Object.keys(trigger.on).length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["on"],
          message: "at least one event is required",
        });
      }
      if ("choices" in trigger.run.agent && Object.keys(trigger.run.agent.choices).length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["run", "agent", "choices"],
          message: "at least one agent choice is required",
        });
      }
    });
}

function validateTriggerEventEntry(
  event: string,
  definition: z.infer<typeof TriggerEventSchema>,
  inputs: TriggerDocument["inputs"],
  registry: IntegrationRegistry,
  context: z.RefinementCtx,
): void {
  if (event === "schedule.tick") {
    validateSchedule(definition, inputs, context);
  } else if (definition.recurrence !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["on", event, "recurrence"],
      message: "Recurrence is only supported for schedule.tick.",
    });
  }
  if (event === "webhook.received") validateWebhook(definition, inputs, context);
  validateEventFilters(event, definition.filters, registry, context);
  validateEventQualifiers(event, definition.filters, registry, context);
}

function validateSchedule(
  definition: z.infer<typeof TriggerEventSchema>,
  inputs: TriggerDocument["inputs"],
  context: z.RefinementCtx,
): void {
  if (
    definition.recurrence === undefined ||
    definition.connection !== undefined ||
    definition.filters !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["on", "schedule.tick"],
      message: "Schedule requires recurrence and does not accept connection or filters.",
    });
  }
  // A tick supplies no inputs; it runs with the declared defaults.
  for (const [name, input] of Object.entries(inputs ?? {})) {
    if (input.required !== true) continue;
    context.addIssue({
      code: "custom",
      path: ["inputs", name],
      message: "A trigger with a schedule cannot require an input; give it a default.",
    });
  }
}

function validateEventFilters(
  event: string,
  filters: TriggerFilter | undefined,
  registry: IntegrationRegistry,
  context: z.RefinementCtx,
): void {
  if (filters === undefined) return;
  const registered = registry.forEvent(event);
  const filterSchema =
    registered?.integration.triggers !== undefined
      ? TriggerFilterSchema.extend(registered.integration.triggers.filterSchema.shape).strict()
      : TriggerFilterSchema;
  const parsedFilters = filterSchema.safeParse(filters);
  if (!parsedFilters.success) {
    for (const issue of parsedFilters.error.issues) {
      context.addIssue({
        code: "custom",
        path: ["on", event, "filters", ...issue.path],
        message: issue.message,
      });
    }
    return;
  }
  registered?.integration.triggers?.validateEventFilters?.(event, parsedFilters.data, context);
}

function validateEventQualifiers(
  event: string,
  filters: TriggerFilter | undefined,
  registry: IntegrationRegistry,
  context: z.RefinementCtx,
): void {
  const registered = registry.forEvent(event);
  let qualifiers = registered?.event.qualifiers;
  if (qualifiers === undefined) {
    qualifiers = isEditorEvent(event) ? eventDefinition(event).qualifiers : [];
  }
  for (const qualifier of qualifiers) {
    const value = filters?.[qualifier.key];
    if (qualifier.required && (typeof value !== "string" || value.trim().length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["on", event, "filters", qualifier.key],
        message: `${qualifier.label} is required.`,
      });
    }
  }
}

export const TriggerDocumentSchema = buildTriggerDocumentSchema(defaultIntegrationRegistry);

export type TriggerDocument = z.infer<typeof TriggerDocumentSchema>;

function validateWebhook(
  definition: z.infer<typeof TriggerEventSchema>,
  inputs: TriggerDocument["inputs"],
  context: z.RefinementCtx,
): void {
  if (definition.connection !== undefined || definition.filters !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["on", "webhook.received"],
      message: "Webhook does not accept connection or filters.",
    });
  }
  for (const [name, input] of Object.entries(inputs ?? {})) {
    if (input.required !== true) continue;
    context.addIssue({
      code: "custom",
      path: ["inputs", name],
      message: "A webhook cannot supply required trigger inputs.",
    });
  }
}
