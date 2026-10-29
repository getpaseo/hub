import { createResendEmailDelivery, readResendConfig } from "./internal/resend.js";
import { createSesEmailDelivery, readSesConfig } from "./internal/ses.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export interface EmailDelivery {
  send(message: EmailMessage): Promise<void>;
}

/**
 * One production delivery boundary shared by every Hub email workflow. Resend wins when
 * `RESEND_API_KEY` is set; otherwise Amazon SES is used when `SES_FROM` is set.
 */
export function composeEmailDelivery(
  environment: Record<string, string | undefined> = process.env,
): EmailDelivery | undefined {
  const resend = readResendConfig(environment);
  if (resend !== undefined) return createResendEmailDelivery(resend);
  const ses = readSesConfig(environment);
  return ses === undefined ? undefined : createSesEmailDelivery(ses);
}
