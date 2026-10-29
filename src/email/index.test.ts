import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { composeEmailDelivery } from "./index.js";

const resend = { RESEND_API_KEY: "re_test_abc123", RESEND_FROM: "mail@example.com" };
const ses = {
  SES_FROM: "mail@example.com",
  SES_REGION: "eu-west-1",
  SES_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  SES_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const message = {
  to: "person@example.com",
  subject: "Subject",
  text: "Text",
  html: "<p>HTML</p>",
  idempotencyKey: "paseo-message-one",
};

async function deliveredUrl(environment: Record<string, string | undefined>): Promise<string> {
  const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response("{}", { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  const delivery = composeEmailDelivery(environment);
  assert.ok(delivery !== undefined);
  await delivery.send(message);
  const input = fetchMock.mock.calls[0]?.[0];
  assert.ok(typeof input === "string");
  return input;
}

describe("email delivery composition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is absent without provider configuration", () => {
    assert.equal(composeEmailDelivery({}), undefined);
  });

  it("uses Resend when only Resend is configured", async () => {
    assert.equal(await deliveredUrl(resend), "https://api.resend.com/emails");
  });

  it("uses Amazon SES when only SES is configured", async () => {
    assert.equal(
      await deliveredUrl(ses),
      "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails",
    );
  });

  it("prefers Resend when both providers are configured", async () => {
    assert.equal(await deliveredUrl({ ...resend, ...ses }), "https://api.resend.com/emails");
  });

  it("rejects invalid configuration", () => {
    assert.throws(() => composeEmailDelivery({ SES_FROM: "mail@example.com" }), /SES_REGION/);
    assert.throws(
      () => composeEmailDelivery({ RESEND_API_KEY: "re_test_abc123", ...ses }),
      /RESEND_FROM is required/,
    );
  });
});
