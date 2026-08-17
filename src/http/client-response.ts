/**
 * Relinquish an outbound response without inspecting its body. Cancelling releases the stream;
 * aborting the request owner closes an incomplete peer instead of leaving its connection pooled.
 */
export async function discardClientResponse(
  response: Response,
  controller: AbortController,
  reason: Error,
): Promise<void> {
  // Abort while fetch still owns the response. Cancelling first can detach an unfinished body and
  // make a later abort unable to close its HTTP connection.
  controller.abort(reason);
  try {
    await response.body?.cancel();
  } catch {
    // The caller's material failure remains authoritative; abort above owns transport cleanup.
  }
}
