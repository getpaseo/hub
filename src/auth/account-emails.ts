import { createHash } from "node:crypto";
import type { EmailDelivery } from "../email/index.js";

interface AccountEmail {
  user: { email: string };
  url: string;
  token: string;
}

export interface AccountMailer {
  sendVerificationEmail(email: AccountEmail): Promise<void>;
  sendPasswordReset(email: AccountEmail): Promise<void>;
}

export function createAccountMailer(delivery: EmailDelivery): AccountMailer {
  return {
    sendVerificationEmail: (email) =>
      delivery.send({
        to: email.user.email,
        subject: "Verify your Paseo Hub email",
        text: `Verify your email address to finish creating your Paseo Hub account:\n\n${email.url}\n\nThis link expires in one hour.`,
        html: `<p>Verify your email address to finish creating your Paseo Hub account.</p><p><a href="${escapeHtml(email.url)}">Verify email</a></p><p>This link expires in one hour.</p>`,
        idempotencyKey: emailKey("verification", email.token),
      }),
    sendPasswordReset: (email) =>
      delivery.send({
        to: email.user.email,
        subject: "Reset your Paseo Hub password",
        text: `Set a new password for your Paseo Hub account:\n\n${email.url}\n\nThis link expires in one hour. If you did not request this, you can ignore this email.`,
        html: `<p>Set a new password for your Paseo Hub account.</p><p><a href="${escapeHtml(email.url)}">Reset password</a></p><p>This link expires in one hour. If you did not request this, you can ignore this email.</p>`,
        idempotencyKey: emailKey("password-reset", email.token),
      }),
  };
}

function emailKey(kind: string, token: string): string {
  return `paseo-${kind}-${createHash("sha256").update(token).digest("hex")}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
