import type { AccountMailer } from "../../auth/account-emails.js";

export type BrowserAccountEmailKind = "verification" | "password-reset";

interface SentAccountEmail {
  email: string;
  url: string;
}

export class BrowserAccountEmails implements AccountMailer {
  private readonly verifications: SentAccountEmail[] = [];
  private readonly passwordResets: SentAccountEmail[] = [];

  sendVerificationEmail(message: { user: { email: string }; url: string }): Promise<void> {
    this.verifications.push({ email: message.user.email.toLowerCase(), url: message.url });
    return Promise.resolve();
  }

  sendPasswordReset(message: { user: { email: string }; url: string }): Promise<void> {
    this.passwordResets.push({ email: message.user.email.toLowerCase(), url: message.url });
    return Promise.resolve();
  }

  latestLink(email: string, kind: BrowserAccountEmailKind): string {
    const messages = kind === "verification" ? this.verifications : this.passwordResets;
    const match = messages.findLast((message) => message.email === email.toLowerCase());
    if (match === undefined) throw new Error(`${kind} email unavailable for ${email}`);
    return match.url;
  }
}
