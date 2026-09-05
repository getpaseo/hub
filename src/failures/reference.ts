/**
 * Appends the correlation ID, after the copy that is actually useful and with the one instruction
 * that makes it worth reading. A bare identifier at the end of a sentence tells the reader
 * nothing about what they are supposed to do with it.
 *
 * Pure so browser bundles can phrase a reference the same way the server does.
 */
export function withReference(message: string, requestId: string): string {
  return `${message} If it happens again, quote reference ${requestId} when reporting it.`;
}
