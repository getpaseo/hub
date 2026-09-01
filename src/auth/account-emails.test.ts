import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { EmailDelivery, EmailMessage } from "../email/index.js";
import { createAccountMailer } from "./account-emails.js";

describe("account email presentation", () => {
  it("delivers escaped verification and password-reset links", async () => {
    const delivery = new RecordingDelivery();
    const mailer = createAccountMailer(delivery);
    await mailer.sendVerificationEmail({
      user: { email: "person@example.com" },
      url: "https://hub.example/api/auth/verify-email?token=one&callbackURL=two",
      token: "verification-token",
    });
    await mailer.sendPasswordReset({
      user: { email: "person@example.com" },
      url: "https://hub.example/api/auth/reset-password/token?callbackURL=two&next=three",
      token: "reset-token",
    });

    assert.equal(delivery.sent.length, 2);
    assert.match(delivery.sent[0]!.subject, /Verify/);
    assert.match(delivery.sent[0]!.html, /token=one&amp;callbackURL=two/);
    assert.match(delivery.sent[1]!.subject, /Reset/);
    assert.match(delivery.sent[1]!.html, /callbackURL=two&amp;next=three/);
    assert.notEqual(delivery.sent[0]!.idempotencyKey, delivery.sent[1]!.idempotencyKey);
    assert.doesNotMatch(delivery.sent[0]!.idempotencyKey, /verification-token/);
  });
});

class RecordingDelivery implements EmailDelivery {
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}
