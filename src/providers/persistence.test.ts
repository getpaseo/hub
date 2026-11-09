import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { SlackConnectionRecord } from "../db/types.js";
import { organizationConnections } from "./resources.js";
import { createProviderRegistry } from "./server.js";
import { slackPersistence } from "./slack/persistence.js";
const providers = createProviderRegistry();

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
    const first = createMemoryDatabase({
      providerData: { slack: { connections: [connection("first", "first-token")] } },
    });
    const second = createMemoryDatabase({
      providerData: { slack: { connections: [connection("second", "second-token")] } },
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
    const firstView = await organizationConnections(first, providers, "first");
    const secondView = await organizationConnections(second, providers, "first");
    assert.deepEqual(
      firstView
        .flatMap((entry) => entry.connections)
        .map((row) => ({ id: row.id, label: row.label })),
      [{ id: "first", label: "Acme" }],
    );
    assert.deepEqual(
      secondView.flatMap((entry) => entry.connections),
      [],
    );
  });
});
