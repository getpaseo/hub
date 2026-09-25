/**
 * Delete the previous reaction (if any) and create the new one. A stray leftover
 * reaction is not worth failing the lifecycle callback over, so delete failures
 * just get reported through onDeleteFailure.
 */
export async function reactToForgeLifecycle<TSubject, TPrevious, TReactionState>(
  subject: TSubject | null,
  previous: TPrevious | undefined,
  deletePrevious: (subject: TSubject, previous: TPrevious) => Promise<void>,
  createNew: (subject: TSubject) => Promise<TReactionState>,
  onDeleteFailure: (error: unknown) => void,
): Promise<TReactionState | null> {
  if (subject === null) return null;
  if (previous !== undefined) {
    try {
      await deletePrevious(subject, previous);
    } catch (error) {
      onDeleteFailure(error);
    }
  }
  return createNew(subject);
}
