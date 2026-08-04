import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { createHubApplication } from "./app.js";
import { createMemoryDatabase } from "./db/memory.js";

describe("Hub application", () => {
  it("serves execution completion capabilities without reply executors", async () => {
    const application = createHubApplication({ database: createMemoryDatabase() });

    const response = await application.operations.handleExecutionCapabilities(
      new Request("https://hub.test/mcp", { method: "POST" }),
      randomUUID(),
    );

    assert.equal(response.status, 401);
  });
});
