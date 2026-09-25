import { RecurrenceSchema } from "../schedule/recurrence.js";
import { z } from "zod";
import { ContinuationSchema } from "../continuation.js";
import { eventDefinition, isEditorEvent } from "./events.js";
import { AuthoredGitHubAuthoritySchema } from "../../config/github-authority.js";
import { allowedFilterKeysForProvider } from "../../config/filter-keys.js";

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

export const TriggerFilterSchema = z
  .object({
    pattern: z.string().optional(),
    contains: z.string().optional(),
    label: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).min(1).optional(),
    repo: z.string().min(1).optional(),
    guild: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    states: z.array(z.string().min(1)).min(1).optional(),
    exclude_labels: z.array(z.string().min(1)).min(1).optional(),
    assignees: z.array(z.string().min(1)).min(1).optional(),
    reviewers: z.array(z.string().min(1)).min(1).optional(),
    branches: z.array(z.string().min(1)).min(1).optional(),
    channels: z.array(z.string().min(1)).optional(),
    from_users: z.array(z.string().min(1)).optional(),
    inputs: z.record(z.string(), InputValueSchema).optional(),
  })
  .strict();

export const TriggerEventSchema = z
  .object({
    recurrence: RecurrenceSchema.optional(),
    connection: z.string().regex(CONNECTION_SLUG).optional(),
    filters: TriggerFilterSchema.optional(),
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

export const TriggerRunSchema = z
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
    output: z
      .object({ schema: z.record(z.string(), z.unknown()) })
      .strict()
      .optional(),
    outputs: z.record(z.string().regex(EVENT_NAME), TriggerOutputSchema).optional(),
    auto_archive: z.boolean().default(true),
  })
  .strict();

/** Split out of the document's superRefine to keep its cyclomatic complexity under
 * the lint cap. Applies filter-keys.ts's table with a per-key issue path. */
function checkFilterKeysBelongToProvider(input: {
  event: string;
  definition: z.infer<typeof TriggerEventSchema>;
  provider: string;
  context: z.RefinementCtx;
}): void {
  const allowedFilterKeys = allowedFilterKeysForProvider(input.provider);
  if (allowedFilterKeys === undefined) return;
  for (const key of Object.keys(input.definition.filters ?? {})) {
    if (!allowedFilterKeys.has(key)) {
      input.context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["on", input.event, "filters", key],
        message: `${key} is not a ${input.provider} filter.`,
      });
    }
  }
}

/** The editor-document mirror of compiler.ts's validateForgejoEventScopedFilters, with
 * a per-field issue path instead of a thrown error. */
function checkForgejoFilterScopedToEvent(input: {
  event: string;
  definition: z.infer<typeof TriggerEventSchema>;
  context: z.RefinementCtx;
}): void {
  if (!input.event.startsWith("forgejo.")) return;
  if (
    input.definition.filters?.assignees !== undefined &&
    input.event !== "forgejo.issue_assigned" &&
    input.event !== "forgejo.pull_request_assigned"
  ) {
    input.context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["on", input.event, "filters", "assignees"],
      message: "assignees only matches forgejo.issue_assigned or forgejo.pull_request_assigned.",
    });
  }
  if (
    input.definition.filters?.reviewers !== undefined &&
    input.event !== "forgejo.pull_request_review_requested"
  ) {
    input.context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["on", input.event, "filters", "reviewers"],
      message: "reviewers only matches forgejo.pull_request_review_requested.",
    });
  }
  if (input.definition.filters?.branches !== undefined && input.event !== "forgejo.push") {
    input.context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["on", input.event, "filters", "branches"],
      message: "branches only matches forgejo.push.",
    });
  }
}

export const TriggerDocumentSchema = z
  .object({
    name: z.string().regex(IDENTIFIER),
    enabled: z.boolean().default(true),
    on: z.record(z.string().regex(EVENT_NAME), TriggerEventSchema),
    inputs: z.record(z.string().regex(IDENTIFIER), TriggerInputSchema).optional(),
    /** A distinct whole-trigger deadline; new one-run triggers normally omit it. */
    max_runtime: z.string().min(1).optional(),
    run: TriggerRunSchema,
  })
  .strict()
  .superRefine((trigger, context) => {
    for (const [event, definition] of Object.entries(trigger.on)) {
      if (event === "schedule.tick") {
        if (
          definition.recurrence === undefined ||
          definition.connection !== undefined ||
          definition.filters !== undefined
        ) {
          context.addIssue({
            code: "custom",
            path: ["on", event],
            message: "Schedule requires recurrence and does not accept connection or filters.",
          });
        }
        if (Object.keys(trigger.on).length !== 1 || trigger.inputs !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["on", event],
            message: "A schedule must be the only event and cannot require invocation inputs.",
          });
        }
      } else if (definition.recurrence !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["on", event, "recurrence"],
          message: "Recurrence is only supported for schedule.tick.",
        });
      }
      if (!isEditorEvent(event)) continue;
      const provider = eventDefinition(event).provider;
      checkFilterKeysBelongToProvider({ event, definition, provider, context });
      checkForgejoFilterScopedToEvent({ event, definition, context });
      for (const qualifier of eventDefinition(event).qualifiers) {
        const value = definition.filters?.[qualifier.key];
        const empty =
          value === undefined ||
          (typeof value === "string" ? value.trim().length === 0 : value.length === 0);
        if (qualifier.required && empty) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["on", event, "filters", qualifier.key],
            message: `${qualifier.label} is required.`,
          });
        }
      }
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

export type TriggerDocument = z.infer<typeof TriggerDocumentSchema>;
