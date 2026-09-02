import { z } from "zod";

/** Marketing entry parameter. Add future signup offers here, then dispatch them in billing. */
export const SIGNUP_INTENT_QUERY_PARAMETER = "plan";
export const SIGNUP_INTENT_COOKIE = "paseo_signup_plan";
export const signupIntentSchema = z.enum(["trial"]);
export type SignupIntent = z.infer<typeof signupIntentSchema>;

/** The post-commit signup event shared by auth and the hosted billing integration. */
export interface OrganizationCreatedEvent {
  organizationId: string;
  accountEmail: string;
  accountName: string;
  intent: SignupIntent;
}

export const DEFAULT_SIGNUP_INTENT: SignupIntent = "trial";

export function parseSignupIntent(value: unknown): SignupIntent | undefined {
  const parsed = signupIntentSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function signupIntentOrDefault(value: unknown): SignupIntent {
  return parseSignupIntent(value) ?? DEFAULT_SIGNUP_INTENT;
}
