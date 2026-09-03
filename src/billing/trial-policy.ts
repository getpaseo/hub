/** The single cardless-trial duration used by Stripe policy and billing copy. */
export const TRIAL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days left before a trial ends, or null when the organization is not on one — paid, free,
 * cancelled, and never-subscribed all answer null here so no surface has to re-derive "is this a
 * trial" from a status string. A partial day counts as a whole one: the final hours of a trial
 * read "1 day left", never "0 days left".
 */
export function trialDaysRemaining(
  subscription: { status: string | null; trialEnd: string | null },
  now: Date = new Date(),
): number | null {
  if (subscription.status !== "trialing" || subscription.trialEnd === null) return null;
  const endsAt = Date.parse(subscription.trialEnd);
  if (Number.isNaN(endsAt)) return null;
  return Math.max(0, Math.ceil((endsAt - now.getTime()) / DAY_MS));
}
