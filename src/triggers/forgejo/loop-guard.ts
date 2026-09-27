import { z } from "zod";
import type { NormalizedForgejoEvent } from "./events.js";

/**
 * Whether a delivery's sender is this connection's own account, or a sibling Forgejo
 * connection's on the same organization and instance (two bots on overlapping
 * repositories can see each other's writes too). Compared by numeric account id, not
 * login, since an account can be renamed after the connection was created.
 */
export function isForgejoOwnAccountEvent(
  event: Pick<NormalizedForgejoEvent, "payload">,
  accountIds: readonly number[],
): boolean {
  const parsed = SenderPayloadSchema.safeParse(event.payload).data;
  // action_run_failure/success carries no sender (a CI run finished, nothing posted
  // it), so fall back to run.trigger_user.
  const sender = parsed?.sender?.id ?? parsed?.run?.trigger_user?.id;
  return sender !== undefined && accountIds.includes(sender);
}

const SenderPayloadSchema = z
  .object({
    sender: z
      .object({ id: z.number().optional().catch(undefined) })
      .passthrough()
      .optional()
      .catch(undefined),
    run: z
      .object({
        trigger_user: z
          .object({ id: z.number().optional().catch(undefined) })
          .passthrough()
          .optional()
          .catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();
