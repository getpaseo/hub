import { z } from "zod";
import type { OutputExecutor, OutputToolDefinition } from "../../execution-capabilities/outputs.js";
import type { LinearApiClient } from "../../providers/linear/client.js";

/**
 * Output type of the Linear reply tool. Shared by the provider registration
 * (which registers the output) and the trigger provider (which reads the
 * emission count to decide whether a session still needs an explicit close).
 */
export const LINEAR_REPLY_OUTPUT_TYPE = "linear.reply";

const LinearReplyArgsSchema = z.object({
  content: z.string().min(1),
  kind: z.enum(["response", "question"]).default("response"),
  options: z.array(z.string().min(1)).optional(),
});
const LinearReplyOutputContextSchema = z.object({
  provider: z.literal("linear"),
  linearOrganizationId: z.string().min(1),
  issueId: z.string().min(1),
  agentSessionId: z.string().min(1).nullable(),
  // Optional: executions recorded before threading existed carry no root comment.
  threadRootCommentId: z.string().min(1).nullable().optional(),
});

/**
 * The shared reply tool only carries `content`; Linear agent sessions additionally distinguish a
 * final answer (`response`, closes the session) from a question (`elicitation`, leaves the session
 * awaiting input), optionally with a fixed list of choices.
 *
 * The elicitation body does not repeat the choices: they travel in `signalMetadata`, which the
 * session history reread on the next execution does not retain (only `body` is kept). The
 * question text should therefore stand on its own once the user's answer comes back.
 */
export const linearReplyOutputTool: OutputToolDefinition = {
  name: "reply",
  description:
    "Sends a reply to the conversation that triggered this execution. " +
    'Use kind "question" when you need an answer before continuing: post the question, then call ' +
    "finish_execution. The user's answer arrives as a NEW execution; do not wait for it here. " +
    "Provide options to offer fixed choices (the user may still answer freely).",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", minLength: 1 },
      kind: { type: "string", enum: ["response", "question"] },
      options: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
      },
    },
    required: ["content"],
    additionalProperties: false,
  },
};

/**
 * Replies through the native agent session when present, otherwise through an issue comment,
 * threaded under the triggering comment's root when the context carries one.
 */
export function createLinearReplyExecutor(options: { client: LinearApiClient }): OutputExecutor {
  return async function executeLinearReply(input) {
    const args = LinearReplyArgsSchema.parse(input.args);
    const context = LinearReplyOutputContextSchema.parse(input.outputContext);
    if (context.agentSessionId !== null) {
      const choices = questionChoices(args);
      await options.client.createAgentActivity({
        linearOrganizationId: context.linearOrganizationId,
        agentSessionId: context.agentSessionId,
        content: {
          type: args.kind === "question" ? "elicitation" : "response",
          body: args.content,
        },
        ...(choices.length === 0
          ? {}
          : {
              signal: "select",
              signalMetadata: {
                options: choices.map((choice) => ({
                  label: choice,
                  value: choice,
                })),
              },
            }),
      });
      return;
    }
    await options.client.createComment({
      linearOrganizationId: context.linearOrganizationId,
      issueId: context.issueId,
      body: commentBody(args),
      ...(typeof context.threadRootCommentId === "string"
        ? { parentId: context.threadRootCommentId }
        : {}),
    });
  };
}

/** Issue comments have no elicitation: a question with choices lists them in Markdown instead. */
function commentBody(args: z.infer<typeof LinearReplyArgsSchema>): string {
  const choices = questionChoices(args);
  return choices.length === 0
    ? args.content
    : `${args.content}\n\n${choices.map((choice) => `- ${choice}`).join("\n")}`;
}

/** Only a question carries choices; a duplicated choice would render twice in Linear's select. */
function questionChoices(args: z.infer<typeof LinearReplyArgsSchema>): string[] {
  return args.kind === "question" ? [...new Set(args.options ?? [])] : [];
}
