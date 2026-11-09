import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createProviderRegistry } from "../../providers/server.js";
import { readProviderApplicationEnvironment } from "./environment.js";
const providerRegistry = createProviderRegistry();

describe("Slack provider environment", () => {
  const webhook = {
    SLACK_APP_ID: "A1",
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_SIGNING_SECRET: "signing",
  };

  it.each([
    [
      { SLACK_TRANSPORT: "socket", SLACK_APP_ID: "A1", SLACK_APP_TOKEN: "xapp-token" },
      { provider: "slack", transport: "socket", appId: "A1", appToken: "xapp-token" },
    ],
    [
      webhook,
      {
        provider: "slack",
        transport: "webhook",
        appId: "A1",
        clientId: "client",
        clientSecret: "secret",
        signingSecret: "signing",
      },
    ],
    [
      { ...webhook, SLACK_TRANSPORT: "webhook" },
      {
        provider: "slack",
        transport: "webhook",
        appId: "A1",
        clientId: "client",
        clientSecret: "secret",
        signingSecret: "signing",
      },
    ],
  ] as const)("accepts a complete Slack group", async (environment, expected) => {
    assert.deepEqual(
      (await readProviderApplicationEnvironment(environment, providerRegistry))["slack"],
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
        readProviderApplicationEnvironment(environment, providerRegistry),
        /Slack environment configuration/i,
      );
    }
  });
});
