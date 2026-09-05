import { z } from "zod";
import type { EmailDelivery, EmailMessage } from "../index.js";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const DELIVERY_TIMEOUT_MS = 10_000;

export interface ResendConfig {
  apiKey: string;
  from: string;
}

type SendRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const apiKeySchema = z
  .string()
  .trim()
  .min(1, "RESEND_API_KEY must not be blank")
  .refine((value) => value.startsWith("re_"), 'RESEND_API_KEY must start with "re_"');

const senderSchema = z.string().trim().min(1, "RESEND_FROM must not be blank");

export function readResendConfig(
  environment: Record<string, string | undefined>,
): ResendConfig | undefined {
  const rawKey = environment["RESEND_API_KEY"];
  if (rawKey === undefined || rawKey.trim().length === 0) return undefined;
  const key = apiKeySchema.safeParse(rawKey);
  if (!key.success) {
    throw new Error(`RESEND_API_KEY is invalid: ${key.error.issues[0]?.message}`);
  }
  const rawFrom = environment["RESEND_FROM"];
  if (rawFrom === undefined || rawFrom.trim().length === 0) {
    throw new Error("RESEND_FROM is required when RESEND_API_KEY is set");
  }
  return { apiKey: key.data, from: senderSchema.parse(rawFrom) };
}

export function createResendEmailDelivery(
  config: ResendConfig,
  sendRequest: SendRequest = fetch,
): EmailDelivery {
  return {
    async send(message: EmailMessage) {
      const response = await sendRequest(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey,
        },
        body: JSON.stringify({
          from: config.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Resend rejected email with status ${response.status}`);
      }
    },
  };
}
