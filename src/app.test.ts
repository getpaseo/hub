import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { createHubApplication } from "./app.js";
import { createMemoryDatabase } from "./db/memory.js";
import { createUnlimitedEntitlementsService } from "./entitlements/test-utils.js";
import { createProviderRegistry as createCompositionProviders } from "./providers/server.js";
const compositionProviders = createCompositionProviders();

describe("Hub application", () => {
  it("serves execution completion capabilities without reply executors", async () => {
    const application = createHubApplication({
      providerRegistry: compositionProviders,
      database: createMemoryDatabase(),
      entitlements: createUnlimitedEntitlementsService(),
      publicApi: { status: "unavailable" },
    });

    const response = await application.operations.handleExecutionCapabilities(
      new Request("https://hub.test/mcp", { method: "POST" }),
      randomUUID(),
    );

    assert.equal(response.status, 401);
  });
});
