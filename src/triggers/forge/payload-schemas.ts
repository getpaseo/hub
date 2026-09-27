import { z } from "zod";

/**
 * Issue, pull request, and comment webhook payload schemas, shared because Forgejo
 * reproduces GitHub's fields exactly. GitHub's review schemas in auth/github-events.ts
 * still extend PullRequestPayloadSchema from here.
 */

const OptionalStringSchema = z.string().optional().catch(undefined);
const OptionalNumberSchema = z.number().optional().catch(undefined);
const UserSchema = z
  .object({ login: OptionalStringSchema })
  .passthrough()
  .optional()
  .catch(undefined);
const LabelSchema = z.object({ name: OptionalStringSchema }).passthrough();
const AssigneeSchema = z.object({ login: OptionalStringSchema }).passthrough();

export const IssueCommentPayloadSchema = z
  .object({
    action: OptionalStringSchema,
    issue: z
      .object({
        number: OptionalNumberSchema,
        title: OptionalStringSchema,
        body: OptionalStringSchema,
        html_url: OptionalStringSchema,
        user: UserSchema,
        labels: z.array(LabelSchema).optional().catch(undefined),
        pull_request: z.object({}).passthrough().optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    comment: z
      .object({
        id: OptionalNumberSchema,
        body: OptionalStringSchema,
        user: UserSchema,
      })
      .optional()
      .catch(undefined),
    sender: UserSchema,
  })
  .passthrough();

export const IssuesPayloadSchema = z
  .object({
    action: OptionalStringSchema,
    issue: z
      .object({
        number: OptionalNumberSchema,
        title: OptionalStringSchema,
        body: OptionalStringSchema,
        html_url: OptionalStringSchema,
        user: UserSchema,
        labels: z.array(LabelSchema).optional().catch(undefined),
        assignees: z.array(AssigneeSchema).optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    sender: UserSchema,
    label: LabelSchema.optional().catch(undefined),
  })
  .passthrough();

export const PullRequestPayloadSchema = z
  .object({
    action: OptionalStringSchema,
    pull_request: z
      .object({
        number: OptionalNumberSchema,
        title: OptionalStringSchema,
        body: OptionalStringSchema,
        html_url: OptionalStringSchema,
        user: UserSchema,
        labels: z.array(LabelSchema).optional().catch(undefined),
        assignees: z.array(AssigneeSchema).optional().catch(undefined),
        head: z
          .object({
            ref: OptionalStringSchema,
          })
          .optional()
          .catch(undefined),
      })
      .optional()
      .catch(undefined),
    sender: UserSchema,
    label: LabelSchema.optional().catch(undefined),
  })
  .passthrough();
