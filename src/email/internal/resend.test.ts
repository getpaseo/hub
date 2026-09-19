import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import { createResendEmailDelivery, readResendConfig } from "./resend.js";

describe("optional Resend email delivery", () => {
  it("is absent when RESEND_API_KEY is absent or blank", () => {
    assert.equal(readResendConfig({}), undefined);
    assert.equal(readResendConfig({ RESEND_API_KEY: "   " }), undefined);
  });

  it("requires a valid key and explicit sender when enabled", () => {
    assert.throws(
      () => readResendConfig({ RESEND_API_KEY: "not-a-key", RESEND_FROM: "mail@example.com" }),
      /RESEND_API_KEY is invalid/,
    );
    assert.throws(
      () => readResendConfig({ RESEND_API_KEY: "re_test_abc123" }),
      /RESEND_FROM is required/,
    );
    assert.deepEqual(
      readResendConfig({
        RESEND_API_KEY: " re_test_abc123 ",
        RESEND_FROM: " Paseo <mail@example.com> ",
      }),
      { apiKey: "re_test_abc123", from: "Paseo <mail@example.com>" },
    );
  });

  it("delivers the message through the configured provider", async () => {
    let request: { input: string; init: RequestInit } | undefined;
    const delivery = createResendEmailDelivery(
      { apiKey: "re_test_abc123", from: "Paseo <mail@example.com>" },
      (input, init = {}) => {
        let inputUrl: string;
        if (typeof input === "string") inputUrl = input;
        else if (input instanceof URL) inputUrl = input.toString();
        else inputUrl = input.url;
        request = { input: inputUrl, init };
        return Promise.resolve(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
      },
    );

    await delivery.send({
      to: "person@example.com",
      subject: "Subject",
      text: "Text",
      html: "<p>HTML</p>",
      idempotencyKey: "paseo-message-one",
    });

    assert.ok(request !== undefined);
    assert.equal(request.input, "https://api.resend.com/emails");
    assert.deepEqual(request.init.headers, {
      Authorization: "Bearer re_test_abc123",
      "Content-Type": "application/json",
      "Idempotency-Key": "paseo-message-one",
    });
    assert.deepEqual(
      (() => {
        const body = request.init.body;
        assert.ok(typeof body === "string");
        return z
          .object({
            from: z.string(),
            to: z.array(z.string()),
            subject: z.string(),
            text: z.string(),
            html: z.string(),
          })
          .parse(JSON.parse(body));
      })(),
      {
        from: "Paseo <mail@example.com>",
        to: ["person@example.com"],
        subject: "Subject",
        text: "Text",
        html: "<p>HTML</p>",
      },
    );
  });

  it("rejects unsuccessful responses without exposing the response body", async () => {
    const delivery = createResendEmailDelivery(
      { apiKey: "re_test_abc123", from: "mail@example.com" },
      () => Promise.resolve(new Response("secret provider detail", { status: 422 })),
    );
    await assert.rejects(
      () =>
        delivery.send({
          to: "person@example.com",
          subject: "Subject",
          text: "Text",
          html: "<p>HTML</p>",
          idempotencyKey: "paseo-message-one",
        }),
      /^Error: Resend rejected email with status 422$/,
    );
  });
});
