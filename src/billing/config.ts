import { z } from "zod";

export interface BillingConfig {
  stripeSecretKey: string;
}

const stripeSecretKeySchema = z
  .string()
  .trim()
  .min(1, "STRIPE_SECRET_KEY must not be blank")
  .refine((value) => value.startsWith("sk_"), 'STRIPE_SECRET_KEY must start with "sk_"');

/**
 * Undefined means self-hosted: no billing routes, no navigation entry, no UI, nothing stamps.
 * `src/billing/` is registered at the composition root only when this returns a config.
 */
export function readBillingConfig(
  environment: Record<string, string | undefined> = process.env,
): BillingConfig | undefined {
  const raw = environment["STRIPE_SECRET_KEY"];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const result = stripeSecretKeySchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`STRIPE_SECRET_KEY is invalid: ${result.error.issues[0]?.message}`);
  }
  return { stripeSecretKey: result.data };
}
