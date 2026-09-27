import { z } from "zod";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { ForgejoApiClient, ForgejoCredentials } from "../../providers/forgejo/client.js";
import { splitForgejoRepository } from "./repository.js";

const ForgejoReplyArgsSchema = z.object({ content: z.string().min(1) });
const ForgejoReplyOutputContextSchema = z.object({
  provider: z.literal("forgejo"),
  connectionId: z.string().min(1),
  repository: z.string().min(3),
  issueNumber: z.number().int().positive().nullable(),
});

/**
 * Posts a comment back on the issue or pull request the delivery came from. Every reply
 * posts with the connection's own token, so the loop guard (`isForgejoOwnAccountEvent`)
 * already drops the echo delivery; there's nothing left to track here.
 */
export function createForgejoReplyExecutor(options: {
  client: ForgejoApiClient;
  credentialsForConnection(connectionId: string): Promise<ForgejoCredentials>;
}): OutputExecutor {
  return async function executeForgejoReply(input) {
    const args = ForgejoReplyArgsSchema.parse(input.args);
    const context = ForgejoReplyOutputContextSchema.parse(input.outputContext);
    if (context.issueNumber === null) {
      throw new Error("forgejo reply needs an issue or pull request to comment on");
    }
    const [owner, repo] = splitForgejoRepository(context.repository);

    await options.client.createIssueComment({
      credentials: await options.credentialsForConnection(context.connectionId),
      owner,
      repo,
      issueNumber: context.issueNumber,
      body: args.content,
    });
  };
}

/** A push event has no issue to answer, so the reply tool hides itself there. */
export function forgejoReplyAvailable(outputContext: unknown): boolean {
  const parsed = ForgejoReplyOutputContextSchema.safeParse(outputContext);
  return parsed.success && parsed.data.issueNumber !== null;
}
