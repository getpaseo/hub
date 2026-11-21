import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import { createSesEmailDelivery, readSesConfig, signAwsRequest, type SesConfig } from "./ses.js";

const ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const message = {
  to: "person@example.com",
  subject: "Subject",
  text: "Text",
  html: "<p>HTML</p>",
  idempotencyKey: "paseo-message-one",
};

const config: SesConfig = {
  region: "eu-west-1",
  from: "Paseo <mail@example.com>",
  credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
  configurationSet: "hub-transactional",
};

const fixedNow = () => new Date("2026-10-27T09:30:00.123Z");

function captureRequest() {
  const captured: { input?: string; init?: RequestInit } = {};
  const sendRequest = (input: string | URL | Request, init: RequestInit = {}) => {
    if (typeof input === "string") captured.input = input;
    else if (input instanceof URL) captured.input = input.toString();
    else captured.input = input.url;
    captured.init = init;
    return Promise.resolve(new Response(JSON.stringify({ MessageId: "email-1" }), { status: 200 }));
  };
  return { captured, sendRequest };
}

describe("optional Amazon SES email delivery", () => {
  it("is absent when SES_FROM is absent or blank", () => {
    assert.equal(readSesConfig({}), undefined);
    assert.equal(readSesConfig({ SES_FROM: "   ", SES_REGION: "eu-west-1" }), undefined);
  });

  it("requires a valid region when enabled", () => {
    assert.throws(
      () => readSesConfig({ SES_FROM: "mail@example.com" }),
      /SES_REGION \(or AWS_REGION\) is required/,
    );
    assert.throws(
      () => readSesConfig({ SES_FROM: "mail@example.com", SES_REGION: "Europe" }),
      /SES_REGION is invalid/,
    );
    assert.throws(
      () => readSesConfig({ SES_FROM: "mail@example.com", AWS_REGION: "eu_west_1" }),
      /AWS_REGION is invalid/,
    );
  });

  it("requires a complete credential pair without echoing it", () => {
    const base = { SES_FROM: "mail@example.com", SES_REGION: "eu-west-1" };
    assert.throws(() => readSesConfig(base), /SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY/);
    assert.throws(
      () => readSesConfig({ ...base, SES_ACCESS_KEY_ID: ACCESS_KEY_ID }),
      /^Error: SES_SECRET_ACCESS_KEY is required when SES_ACCESS_KEY_ID is set$/,
    );
    assert.throws(
      () => readSesConfig({ ...base, AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY }),
      /^Error: AWS_ACCESS_KEY_ID is required when AWS_SECRET_ACCESS_KEY is set$/,
    );
    // SES-specific names never borrow half of an AWS pair.
    assert.throws(
      () =>
        readSesConfig({
          ...base,
          SES_ACCESS_KEY_ID: ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
        }),
      /SES_SECRET_ACCESS_KEY is required/,
    );
    assert.throws(
      () =>
        readSesConfig({
          ...base,
          SES_ACCESS_KEY_ID: "not-a-key-id-but-secretish",
          SES_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^SES_ACCESS_KEY_ID is invalid/);
        assert.doesNotMatch(error.message, /secretish/);
        assert.doesNotMatch(error.message, /EXAMPLEKEY/);
        return true;
      },
    );
  });

  it("reads SES-specific settings", () => {
    assert.deepEqual(
      readSesConfig({
        SES_FROM: " Paseo <mail@example.com> ",
        SES_REGION: " eu-west-1 ",
        AWS_REGION: "us-east-1",
        SES_ACCESS_KEY_ID: ACCESS_KEY_ID,
        SES_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
        SES_SESSION_TOKEN: "ses-token",
        AWS_ACCESS_KEY_ID: "AKIAOTHERKEYEXAMPLE1",
        AWS_SECRET_ACCESS_KEY: "other",
        AWS_SESSION_TOKEN: "aws-token",
        SES_CONFIGURATION_SET: " hub-transactional ",
      }),
      {
        region: "eu-west-1",
        from: "Paseo <mail@example.com>",
        credentials: {
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY,
          sessionToken: "ses-token",
        },
        configurationSet: "hub-transactional",
      },
    );
  });

  it("falls back to the standard AWS variables", () => {
    assert.deepEqual(
      readSesConfig({
        SES_FROM: "mail@example.com",
        AWS_REGION: "us-gov-west-1",
        AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN: "aws-token",
      }),
      {
        region: "us-gov-west-1",
        from: "mail@example.com",
        credentials: {
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY,
          sessionToken: "aws-token",
        },
      },
    );
  });

  it("signs with AWS Signature Version 4", () => {
    // The get-vanilla case from the AWS Signature Version 4 test suite.
    assert.deepEqual(
      signAwsRequest({
        method: "GET",
        url: new URL("https://example.amazonaws.com/"),
        headers: {},
        body: "",
        region: "us-east-1",
        service: "service",
        credentials: {
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        },
        now: new Date("2015-08-30T12:36:00Z"),
      }),
      {
        "X-Amz-Date": "20150830T123600Z",
        Authorization:
          "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
      },
    );
  });

  it("delivers the message through the SES v2 SendEmail API", async () => {
    const { captured, sendRequest } = captureRequest();
    await createSesEmailDelivery(config, sendRequest, fixedNow).send(message);

    assert.equal(captured.input, "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    assert.equal(captured.init?.method, "POST");
    // Signatures below were derived with an independent implementation of Signature Version 4.
    assert.deepEqual(captured.init?.headers, {
      "Content-Type": "application/json",
      "X-Amz-Date": "20261027T093000Z",
      Authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/20261027/eu-west-1/ses/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=9d7646acb336e869b53f5b05ca41c74778b1761ee74a19bdf977ed35f1e9e988`,
    });
    const body = captured.init?.body;
    assert.ok(typeof body === "string");
    const content = z.object({ Data: z.string(), Charset: z.literal("UTF-8") });
    assert.deepEqual(
      z
        .object({
          FromEmailAddress: z.string(),
          Destination: z.object({ ToAddresses: z.array(z.string()) }),
          Content: z.object({
            Simple: z.object({
              Subject: content,
              Body: z.object({ Text: content, Html: content }),
            }),
          }),
          ConfigurationSetName: z.string(),
        })
        .strict()
        .parse(JSON.parse(body)),
      {
        FromEmailAddress: "Paseo <mail@example.com>",
        Destination: { ToAddresses: ["person@example.com"] },
        Content: {
          Simple: {
            Subject: { Data: "Subject", Charset: "UTF-8" },
            Body: {
              Text: { Data: "Text", Charset: "UTF-8" },
              Html: { Data: "<p>HTML</p>", Charset: "UTF-8" },
            },
          },
        },
        ConfigurationSetName: "hub-transactional",
      },
    );
  });

  it("omits the configuration set when none is configured", async () => {
    const { captured, sendRequest } = captureRequest();
    const { configurationSet: _, ...withoutSet } = config;
    await createSesEmailDelivery(withoutSet, sendRequest, fixedNow).send(message);
    const body = captured.init?.body;
    assert.ok(typeof body === "string");
    assert.equal("ConfigurationSetName" in JSON.parse(body), false);
  });

  it("sends and signs a temporary session token", async () => {
    const { captured, sendRequest } = captureRequest();
    await createSesEmailDelivery(
      {
        ...config,
        credentials: { ...config.credentials, sessionToken: "session-token-example" },
      },
      sendRequest,
      fixedNow,
    ).send(message);
    assert.deepEqual(captured.init?.headers, {
      "Content-Type": "application/json",
      "X-Amz-Date": "20261027T093000Z",
      "X-Amz-Security-Token": "session-token-example",
      Authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/20261027/eu-west-1/ses/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=c01395e73cadf2dcbf5739251373ae47888e23f2d01489b7b5282d67d08d59c4`,
    });
  });

  it("rejects unsuccessful responses without exposing the response body or credentials", async () => {
    const delivery = createSesEmailDelivery(config, () =>
      Promise.resolve(new Response("secret provider detail", { status: 403 })),
    );
    await assert.rejects(
      () => delivery.send(message),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Amazon SES rejected email with status 403");
        assert.doesNotMatch(error.message, new RegExp(ACCESS_KEY_ID));
        return true;
      },
    );
  });
});
