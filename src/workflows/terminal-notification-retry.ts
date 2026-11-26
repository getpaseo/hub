import { retryAdvice } from "../failures/index.js";

/** About half an hour of retries: 15 s doubling up to 15 min between the eight attempts. */
const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 15 * 60_000;

export type TerminalNotificationRetry = { abandon: true } | { abandon: false; retryAt: Date };

/**
 * Decides what follows a failed terminal-notification attempt. A permanent failure, or the last
 * allowed attempt, abandons the notification. Otherwise it waits for the exponential backoff
 * with jitter, or longer when the provider asked for a longer wait.
 *
 * @param attempts Attempts started so far, including the one that failed.
 */
export function nextTerminalNotificationAttempt(
  error: unknown,
  attempts: number,
  now: Date,
): TerminalNotificationRetry {
  const advice = retryAdvice(error);
  if (!advice.retryable || attempts >= MAX_ATTEMPTS) return { abandon: true };
  const delayMs = Math.max(advice.retryAfterMs, backoffWithJitterMs(attempts));
  return { abandon: false, retryAt: new Date(now.getTime() + delayMs) };
}

/** Half the exponential delay is fixed and half is random, so failed runs do not retry in step. */
function backoffWithJitterMs(attempts: number): number {
  const delayMs = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1));
  return delayMs / 2 + Math.random() * (delayMs / 2);
}
