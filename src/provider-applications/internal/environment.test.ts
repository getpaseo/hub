import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { describe, it } from "vitest";
import { readProviderApplicationEnvironment } from "./environment.js";

describe("Slack provider environment", () => {
  it("leaves Slack browser-managed when the shipped Docker environment template is copied", async () => {
    const template = parse(await readFile(resolve(process.cwd(), ".env.example")));

    assert.equal((await readProviderApplicationEnvironment(template)).slack, undefined);
  });

  it("accepts the explicit Socket Mode group", async () => {
    assert.deepEqual(
      (
        await readProviderApplicationEnvironment({
          SLACK_TRANSPORT: "socket",
          SLACK_APP_ID: "A1",
          SLACK_APP_TOKEN: "xapp-token",
        })
      ).slack,
      { provider: "slack", transport: "socket", appId: "A1", appToken: "xapp-token" },
    );
  });

  it("accepts explicit webhooks and the complete legacy webhook group", async () => {
    const credentials = {
      SLACK_APP_ID: "A1",
      SLACK_CLIENT_ID: "client",
      SLACK_CLIENT_SECRET: "secret",
      SLACK_SIGNING_SECRET: "signing",
    };
    const expected = {
      provider: "slack",
      transport: "webhook",
      appId: "A1",
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
    };
    assert.deepEqual((await readProviderApplicationEnvironment(credentials)).slack, expected);
    assert.deepEqual(
      (await readProviderApplicationEnvironment({ ...credentials, SLACK_TRANSPORT: "webhook" }))
        .slack,
      expected,
    );
  });

  it("rejects partial, mixed, and unknown Slack groups", async () => {
    for (const environment of [
      { SLACK_APP_ID: "A1" },
      { SLACK_TRANSPORT: "socket", SLACK_APP_ID: "A1" },
      {
        SLACK_TRANSPORT: "socket",
        SLACK_APP_ID: "A1",
        SLACK_APP_TOKEN: "xapp-token",
        SLACK_SIGNING_SECRET: "mixed",
      },
      { SLACK_TRANSPORT: "magic", SLACK_APP_ID: "A1" },
    ]) {
      await assert.rejects(
        readProviderApplicationEnvironment(environment),
        /Slack environment configuration/i,
      );
    }
  });
});
