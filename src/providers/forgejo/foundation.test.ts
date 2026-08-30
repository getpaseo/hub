import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { PROVIDERS } from "../../provider-applications/index.js";
import { createForgejoRegistration, FORGEJO_IDENTITY, FORGEJO_REQUEST_NAMES } from "./index.js";
import { deliveryByName, loadForgejoContractFixtures } from "./fake-server.js";

describe("Forgejo provider foundation", () => {
  it("registers one Hub-wide Forgejo identity and reserved request names", async () => {
    const registration = createForgejoRegistration({
      database: null,
      auth: null,
      applicationBaseUrl: "https://hub.example.test",
      configuration: { provider: "forgejo" },
    });
    assert.equal(registration.connection.name, "forgejo");
    assert.deepEqual(FORGEJO_IDENTITY, { provider: "forgejo", id: "forgejo", name: "Forgejo" });
    assert.deepEqual(
      registration.requests.map((request) => request.name),
      [...FORGEJO_REQUEST_NAMES],
    );
    assert.ok(PROVIDERS.includes("forgejo"));
    assert.equal(PROVIDERS.filter((provider) => provider === "forgejo").length, 1);
    const response = await registration.requests[0]!.handle(
      new Request("https://hub.example.test"),
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "unavailable" });
    assert.deepEqual(
      registration.connection.status({
        github: [],
        discord: [],
        slack: [],
        linear: [],
        forgejo: [],
      }),
      { status: "configured", connections: [] },
    );
  });

  it("loads T00 contract fixtures without rewriting captures", async () => {
    const fixtures = await loadForgejoContractFixtures();
    assert.equal(fixtures.origin, "https://forgejo.example.test");
    assert.equal(fixtures.deliveries.length, 9);
    const opened = deliveryByName(fixtures, "issues-opened");
    assert.equal(opened.event, "issues");
    assert.equal(opened.eventType, "issues");
    assert.equal(opened.semantic, "forgejo.issue_created");
    assert.equal(typeof fixtures.hydration["timelineIssue"], "object");
  });
});
