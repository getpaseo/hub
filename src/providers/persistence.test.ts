import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { SlackConnectionRecord } from "../db/types.js";
import { slackPersistence } from "./slack/persistence.js";

describe("provider persistence ownership", () => {
  it("keeps equal external connection IDs isolated between databases and their read models", async () => {
    const connection = (organizationId: string, token: string): SlackConnectionRecord => ({
      id: organizationId,
      organizationId,
      slug: "slack-acme",
      teamId: "T1",
      teamName: "Acme",
      botUserId: "U1",
      botAccessToken: token,
      scopes: ["chat:write"],
      providerApplicationId: "A1",
    });
    const first = createMemoryDatabase({ slackConnections: [connection("first", "first-token")] });
    const second = createMemoryDatabase({
      slackConnections: [connection("second", "second-token")],
    });

    assert.equal(
      (await slackPersistence(first).findSlackConnection("T1"))?.botAccessToken,
      "first-token",
    );
    assert.equal(
      (await slackPersistence(second).findSlackConnection("T1"))?.botAccessToken,
      "second-token",
    );
    assert.equal(
      await slackPersistence(second).findSlackConnectionForOrganization("first", "T1"),
      undefined,
    );
    assert.deepEqual((await first.organizationConnectionUsage("first")).slack, [
      connection("first", "first-token"),
    ]);
    assert.deepEqual((await second.organizationConnectionUsage("first")).slack, []);
  });
});
